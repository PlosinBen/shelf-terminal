// ACP session drive — the runtime half of the shared acp/ toolkit.
//
// Semantics-free session driver: starts NEW or RESUMES sessions uniformly (the
// SDK's convenience ActiveSession is new-only, so we route session/update
// notifications ourselves through a persistent per-session router) and maps
// updates through the pure `translate` layer onto Shelf's wire. No codex specifics.

import { randomUUID } from 'node:crypto';
import {
  methods,
  type ClientContext,
  type SessionNotification,
  type SessionUpdate,
  type NewSessionResponse,
  type LoadSessionResponse,
  type ResumeSessionResponse,
  type StopReason,
  type McpServer,
  type AvailableCommand,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';
import type { AgentAttachment } from '@shared/types';
import type { OutgoingMessage, SendFn } from '../types';
import { translateSessionUpdate, createToolMetaCarry, imageContentBlocks, DEFAULT_AGENT_MSG_ID } from './translate';
import { readUploadedImageAttachments } from '../shared';
import { serverLog } from '../../server-logger';

interface SessionRouteState {
  send: SendFn | null;
  promptBase: string;
  seg: number;
  streamedSinceTool: boolean;
  thoughtStarted: Set<string>;
  carryToolMeta: ReturnType<typeof createToolMetaCarry>;
}

export interface AcpSession {
  sessionId: string;
  /** Present for NEW sessions (drives capability mapping); absent on resume. */
  newSessionResponse?: NewSessionResponse;
  /** Present for resumed sessions when the agent reports restored native state. */
  resumeSessionResponse?: ResumeSessionResponse;
  /** Present for loaded sessions after replay hydration completes. */
  loadSessionResponse?: LoadSessionResponse;
}

export interface StartSessionOptions {
  cwd: string;
  /** Extra workspace roots (e.g. the projected skills root → codex extraRoots). */
  additionalDirectories?: string[];
  /** App-level MCP servers to hand the agent at session/new (already shaped to ACP). */
  mcpServers?: McpServer[];
}

export const ACP_SESSION_STATE_CHANGES = {
  MODE: 'mode',
  CONFIG_OPTIONS: 'config_options',
} as const;

export type AcpSessionStateChange =
  | {
      kind: typeof ACP_SESSION_STATE_CHANGES.MODE;
      currentModeId: string;
    }
  | {
      kind: typeof ACP_SESSION_STATE_CHANGES.CONFIG_OPTIONS;
      configOptions: SessionConfigOption[];
    };

export interface SessionDriverOptions {
  onStateChange?: (sessionId: string, change: AcpSessionStateChange) => void;
}

export interface SessionDriver {
  /** Register on the ACP connection: routes session/update for the session lifetime. */
  onSessionUpdate(notification: SessionNotification): void;
  startNew(agent: ClientContext, opts: StartSessionOptions): Promise<AcpSession>;
  load(agent: ClientContext, sessionId: string, opts: StartSessionOptions): Promise<AcpSession>;
  resume(agent: ClientContext, sessionId: string, opts: StartSessionOptions): Promise<AcpSession>;
  drivePromptTurn(
    agent: ClientContext,
    session: AcpSession,
    prompt: string,
    send: (msg: OutgoingMessage) => void,
    images?: string[],
    attachments?: AgentAttachment[],
  ): Promise<StopReason>;
  /** Set the session's mode (`session/set_mode`). Mode-id semantics are the agent's. */
  setMode(agent: ClientContext, session: AcpSession, modeId: string): Promise<void>;
  /** Set a session config option value (`session/set_config_option`, select variant). */
  setConfigOption(agent: ClientContext, session: AcpSession, configId: string, value: string): Promise<void>;
  /** The agent's advertised slash commands for a session (captured from
   *  `available_commands_update`, which arrives out-of-turn near session start).
   *  Undefined until the first such update lands. */
  getAvailableCommands(sessionId: string): AvailableCommand[] | undefined;
  /** Drop all routing/presentation state for a session (session ended / reset). */
  forget(sessionId: string): void;
}

export function createSessionDriver(options: SessionDriverOptions = {}): SessionDriver {
  const routeBySession = new Map<string, SessionRouteState>();
  // Per-session slash commands captured from `available_commands_update` (arrives
  // out-of-turn near session start; the backend reads it at gatherCapabilities).
  const commandsBySession = new Map<string, AvailableCommand[]>();
  // session/load replays prior conversation by protocol. Shelf already restores
  // its timeline from local history, so consume metadata during hydration but
  // suppress renderable replay to avoid duplicate messages.
  const hydratingSessions = new Set<string>();
  function routeState(sessionId: string): SessionRouteState {
    let state = routeBySession.get(sessionId);
    if (!state) {
      state = {
        send: null,
        promptBase: `${sessionId}#0`,
        seg: 0,
        streamedSinceTool: false,
        thoughtStarted: new Set<string>(),
        carryToolMeta: createToolMetaCarry(),
      };
      routeBySession.set(sessionId, state);
    }
    return state;
  }

  function routeUpdate(sessionId: string, update: SessionUpdate): void {
    const state = routeState(sessionId);
    const carriedUpdate = state.carryToolMeta(update);
    const namespaced = (msgId: string, streamType?: string): string =>
      msgId === DEFAULT_AGENT_MSG_ID ? `${state.promptBase}:${streamType ?? 'msg'}:${state.seg}` : msgId;

    for (const raw of translateSessionUpdate(carriedUpdate)) {
      let wire = raw;
      if (wire.type === 'message') {
        // Tool/other card after streamed text = message boundary → next text
        // is a new segment. Consecutive tools do not over-bump.
        if (state.streamedSinceTool) {
          state.seg++;
          state.streamedSinceTool = false;
        }
        wire = { ...wire, msgId: namespaced(wire.msgId) };
      } else if (wire.type === 'stream') {
        wire = { ...wire, msgId: namespaced(wire.msgId, wire.streamType) };
        if (wire.streamType === 'thinking' && !state.thoughtStarted.has(wire.msgId)) {
          const content = wire.content.trimStart();
          if (!content) continue;
          wire = { ...wire, content };
          state.thoughtStarted.add(wire.msgId);
        }
        state.streamedSinceTool = true;
      }
      if (state.send) state.send(wire);
      else {
        // Session setup normally emits metadata-only updates. A renderable update
        // before the first prompt has no provider output callback to reach main;
        // surface that protocol anomaly instead of silently losing content.
        serverLog('error', 'acp', `session update produced ${wire.type} before output sink was bound (session=${sessionId})`);
      }
    }
  }

  return {
    onSessionUpdate(n) {
      if (n.update.sessionUpdate === 'available_commands_update') {
        commandsBySession.set(n.sessionId, n.update.availableCommands);
      } else if (n.update.sessionUpdate === 'current_mode_update') {
        options.onStateChange?.(n.sessionId, {
          kind: ACP_SESSION_STATE_CHANGES.MODE,
          currentModeId: n.update.currentModeId,
        });
      } else if (n.update.sessionUpdate === 'config_option_update') {
        options.onStateChange?.(n.sessionId, {
          kind: ACP_SESSION_STATE_CHANGES.CONFIG_OPTIONS,
          configOptions: n.update.configOptions,
        });
      }
      if (hydratingSessions.has(n.sessionId)) return;
      routeUpdate(n.sessionId, n.update);
    },

    getAvailableCommands(sessionId) {
      return commandsBySession.get(sessionId);
    },

    async startNew(agent, opts) {
      const res = await agent.request(methods.agent.session.new, {
        cwd: opts.cwd,
        mcpServers: opts.mcpServers ?? [],
        ...(opts.additionalDirectories?.length ? { additionalDirectories: opts.additionalDirectories } : {}),
      });
      routeState(res.sessionId);
      return { sessionId: res.sessionId, newSessionResponse: res };
    },

    async load(agent, sessionId, opts) {
      routeState(sessionId);
      hydratingSessions.add(sessionId);
      try {
        const response = await agent.request(methods.agent.session.load, {
          sessionId,
          cwd: opts.cwd,
          mcpServers: opts.mcpServers ?? [],
          ...(opts.additionalDirectories?.length ? { additionalDirectories: opts.additionalDirectories } : {}),
        });
        return { sessionId, loadSessionResponse: response };
      } catch (error) {
        routeBySession.delete(sessionId);
        commandsBySession.delete(sessionId);
        throw error;
      } finally {
        hydratingSessions.delete(sessionId);
      }
    },

    async resume(agent, sessionId, opts) {
      const response = await agent.request(methods.agent.session.resume, {
        sessionId,
        cwd: opts.cwd,
        ...(opts.additionalDirectories?.length ? { additionalDirectories: opts.additionalDirectories } : {}),
      });
      routeState(sessionId);
      return { sessionId, resumeSessionResponse: response };
    },

    async drivePromptTurn(agent, session, prompt, send, images, attachments) {
      // Text block + any attached images (legacy data URLs or uploaded paths →
      // ACP image ContentBlocks).
      const uploadedImages = (await readUploadedImageAttachments(attachments)).map(({ mimeType, data }) => ({
        type: 'image' as const,
        data,
        mimeType,
      }));
      const content = [{ type: 'text' as const, text: prompt }, ...imageContentBlocks(images), ...uploadedImages];
      // Per-prompt namespace for the messageId-less sentinel. Streams keep their
      // streamType so a prompt's reply text and thinking don't collide with each
      // other (both would otherwise be DEFAULT_AGENT_MSG_ID). Agents that DO send
      // a real messageId (codex) are untouched.
      //
      // `seg` splits messageId-less text at TOOL boundaries. ACP's only message
      // boundary signal is `messageId`, which copilot --acp omits; the spec has no
      // fallback (see the message-id RFD). Mirror Zed's reference client: text
      // arriving AFTER a tool card is a NEW assistant message. Without this, a
      // turn's opening remark and its post-tool closing summary collapse onto one
      // `turnBase:text` card anchored at the FIRST chunk's position — so the
      // closing text is merged up top, above the tool cards, and the turn appears
      // to end with no reply. Bumping `seg` when a tool card follows streamed text
      // gives the later text a fresh msgId → its own card at the right position.
      const state = routeState(session.sessionId);
      state.send = send;
      // A fresh agent-server can resume a session whose history already contains
      // ids minted by an older process. A process-local sequence would restart
      // and collide, so each messageId-less prompt gets an opaque namespace that
      // remains unique across process restarts and resumed history.
      state.promptBase = `${session.sessionId}#${randomUUID()}`;
      state.seg = 0;
      state.streamedSinceTool = false;
      state.thoughtStarted.clear();
      try {
        const res = await agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: content,
        }) as { stopReason: StopReason };
        return res.stopReason;
      } catch (err) {
        send({ type: 'error', error: `ACP prompt failed: ${(err as Error)?.message ?? String(err)}` });
        return 'refusal';
      }
    },

    async setMode(agent, session, modeId) {
      await agent.request(methods.agent.session.setMode, { sessionId: session.sessionId, modeId });
    },

    async setConfigOption(agent, session, configId, value) {
      const response = await agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId,
        value,
      });
      options.onStateChange?.(session.sessionId, {
        kind: ACP_SESSION_STATE_CHANGES.CONFIG_OPTIONS,
        configOptions: response.configOptions,
      });
    },

    forget(sessionId) {
      routeBySession.delete(sessionId);
      commandsBySession.delete(sessionId);
      hydratingSessions.delete(sessionId);
    },
  };
}
