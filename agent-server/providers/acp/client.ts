// ACP session drive — the runtime half of the shared acp/ toolkit.
//
// Semantics-free session driver: starts NEW or RESUMES sessions uniformly (the
// SDK's convenience ActiveSession is new-only, so we route session/update
// notifications ourselves into per-session queues) and pumps each prompt turn's
// stream through the pure `translate` layer onto Shelf's wire. No codex specifics.

import {
  methods,
  type ClientContext,
  type SessionNotification,
  type SessionUpdate,
  type NewSessionResponse,
  type StopReason,
} from '@agentclientprotocol/sdk';
import type { OutgoingMessage } from '../types';
import { translateSessionUpdate, DEFAULT_AGENT_MSG_ID } from './translate';

/** An async FIFO of session updates that unblocks readers on push or done. */
interface UpdateQueue {
  push(u: SessionUpdate): void;
  wake(): void;
  /** Next update, or null once `isDone()` is true and the buffer is drained. */
  next(isDone: () => boolean): Promise<SessionUpdate | null>;
}

function createUpdateQueue(): UpdateQueue {
  const items: SessionUpdate[] = [];
  let waiter: (() => void) | null = null;
  return {
    push(u) { items.push(u); const w = waiter; waiter = null; w?.(); },
    wake() { const w = waiter; waiter = null; w?.(); },
    async next(isDone) {
      for (;;) {
        if (items.length) return items.shift()!;
        if (isDone()) return null;
        await new Promise<void>((r) => { waiter = r; });
      }
    },
  };
}

export interface AcpSession {
  sessionId: string;
  /** Present for NEW sessions (drives capability mapping); absent on resume. */
  newSessionResponse?: NewSessionResponse;
}

export interface StartSessionOptions {
  cwd: string;
  /** Extra workspace roots (e.g. the projected skills root → codex extraRoots). */
  additionalDirectories?: string[];
}

export interface SessionDriver {
  /** Register on the ACP connection: routes session/update into per-session queues. */
  onSessionUpdate(notification: SessionNotification): void;
  startNew(agent: ClientContext, opts: StartSessionOptions): Promise<AcpSession>;
  resume(agent: ClientContext, sessionId: string, opts: StartSessionOptions): Promise<AcpSession>;
  drivePromptTurn(
    agent: ClientContext,
    session: AcpSession,
    prompt: string,
    send: (msg: OutgoingMessage) => void,
  ): Promise<StopReason>;
  /** Set the session's mode (`session/set_mode`). Mode-id semantics are the agent's. */
  setMode(agent: ClientContext, session: AcpSession, modeId: string): Promise<void>;
  /** Set a session config option value (`session/set_config_option`, select variant). */
  setConfigOption(agent: ClientContext, session: AcpSession, configId: string, value: string): Promise<void>;
  /** Drop a session's queue (session ended / reset). */
  forget(sessionId: string): void;
}

export function createSessionDriver(): SessionDriver {
  const queues = new Map<string, UpdateQueue>();
  // Monotonic across turns so a per-turn namespace for messageId-less agents
  // (copilot --acp omits `messageId`) stays unique — otherwise every turn's reply
  // collapses onto the constant DEFAULT_AGENT_MSG_ID and the renderer upserts them
  // all onto one entry (reply shows above the wrong turn).
  let turnSeq = 0;

  return {
    onSessionUpdate(n) {
      queues.get(n.sessionId)?.push(n.update);
    },

    async startNew(agent, opts) {
      const res = await agent.request(methods.agent.session.new, {
        cwd: opts.cwd,
        mcpServers: [],
        ...(opts.additionalDirectories?.length ? { additionalDirectories: opts.additionalDirectories } : {}),
      });
      queues.set(res.sessionId, createUpdateQueue());
      return { sessionId: res.sessionId, newSessionResponse: res };
    },

    async resume(agent, sessionId, opts) {
      await agent.request(methods.agent.session.resume, {
        sessionId,
        cwd: opts.cwd,
        ...(opts.additionalDirectories?.length ? { additionalDirectories: opts.additionalDirectories } : {}),
      });
      queues.set(sessionId, createUpdateQueue());
      return { sessionId };
    },

    async drivePromptTurn(agent, session, prompt, send) {
      const q = queues.get(session.sessionId);
      if (!q) throw new Error(`drivePromptTurn: no queue for session ${session.sessionId}`);

      let done = false;
      const promptDone = agent
        .request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] })
        .finally(() => { done = true; q.wake(); });

      // Per-turn namespace for the messageId-less sentinel. Streams keep their
      // streamType so a turn's reply text and thinking don't collide with each
      // other (both would otherwise be DEFAULT_AGENT_MSG_ID). Agents that DO send
      // a real messageId (codex) are untouched.
      const turnBase = `${session.sessionId}#${++turnSeq}`;
      const namespaced = (msgId: string, streamType?: string): string =>
        msgId === DEFAULT_AGENT_MSG_ID ? `${turnBase}:${streamType ?? 'msg'}` : msgId;

      const textByMsg = new Map<string, string>();
      for (;;) {
        const update = await q.next(() => done);
        if (!update) break;
        for (const raw of translateSessionUpdate(update)) {
          let wire = raw;
          if (wire.type === 'stream') {
            wire = { ...wire, msgId: namespaced(wire.msgId, wire.streamType) };
          } else if (wire.type === 'message') {
            wire = { ...wire, msgId: namespaced(wire.msgId) };
          }
          if (wire.type === 'stream' && wire.streamType === 'text') {
            textByMsg.set(wire.msgId, (textByMsg.get(wire.msgId) ?? '') + wire.content);
          }
          send(wire);
        }
      }
      for (const [msgId, content] of textByMsg) {
        send({ type: 'message', msgId, msgType: 'reply', content });
      }
      try {
        const res = await promptDone;
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
      await agent.request(methods.agent.session.setConfigOption, { sessionId: session.sessionId, configId, value });
    },

    forget(sessionId) {
      queues.delete(sessionId);
    },
  };
}
