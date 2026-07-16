// Copilot agent provider over ACP (ServerBackend), peer to createCodexBackend /
// createCopilotBackend (the native SDK one). Uses the shared, semantics-free
// acp/ toolkit for the runtime and OWNS copilot specifics (binary launch via
// `copilot --acp`, device-flow login, skills root). ACP is an internal detail;
// the provider identity is 'acp-copilot' (a PARALLEL, dev-gated backend that at
// cutover replaces native 'copilot' — see the copilot-acp feature note).

import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { methods, type Stream, type AgentApp } from '@agentclientprotocol/sdk';
import type { ServerBackend, QueryInput, SendFn, ProviderCapabilities } from '../types';
import { openAcpConnection, spawnAgentStdio, type AcpConnection } from '../acp/connection';
import { createSessionDriver, type AcpSession } from '../acp/client';
import { createPermissionBridge } from '../acp/permission';
import { mapSessionCapabilitiesWithCurrent } from '../acp/capabilities';
import { resolveCopilotAcpCommand, copilotAcpSkillsRoot } from './helpers';
import { startLogin as startCopilotLogin, prefillLoginUrl, type LoginRunner } from '../copilot/login';

export const COPILOT_ACP_PROVIDER = 'acp-copilot';

/** What to connect the ACP client to + the child to reap (production spawns a
 *  `copilot --acp` process; tests inject an in-process mock AgentApp). */
export interface CopilotAgentTarget {
  target: Stream | AgentApp;
  child?: ChildProcess;
}

export interface CopilotAcpDeps {
  /** Open the agent transport for `cwd`. Default: spawn `copilot --acp`. */
  openAgent?: (cwd: string) => CopilotAgentTarget;
}

function defaultOpenAgent(cwd: string): CopilotAgentTarget {
  const { command, args } = resolveCopilotAcpCommand();
  const spawned = spawnAgentStdio(command, args, { cwd });
  return { target: spawned.stream, child: spawned.child };
}

export function createCopilotAcpBackend(deps: CopilotAcpDeps = {}): ServerBackend {
  const openAgent = deps.openAgent ?? defaultOpenAgent;

  let conn: AcpConnection | null = null;
  let child: ChildProcess | null = null;
  let session: AcpSession | null = null;
  let sessionCwd: string | null = null;
  // The active turn's send — the permission bridge rides this lane so requests
  // reach the renderer on the current turn's id.
  let currentSend: SendFn | null = null;
  let loginRunner: LoginRunner | null = null;
  const permissions = createPermissionBridge(() => currentSend);
  const driver = createSessionDriver();

  /** Spawn `copilot --acp` + open the ACP connection once; reused across turns. */
  function ensureConnection(cwd: string): AcpConnection {
    if (conn) return conn;
    const opened = openAgent(cwd);
    child = opened.child ?? null;
    conn = openAcpConnection(opened.target, {
      name: 'shelf-copilot-acp',
      onRequestPermission: permissions.onRequestPermission,
      onSessionUpdate: driver.onSessionUpdate,
    });
    // Drop refs when the agent process/connection ends so the next turn respawns.
    conn.closed.finally(() => {
      conn = null;
      child = null;
      session = null;
      sessionCwd = null;
    });
    return conn;
  }

  /**
   * Establish the session (once per cwd), preferring RESUME of a persisted
   * `lastSdkSessionId` so a reconnect continues the conversation; falls back to
   * a fresh session/new if resume fails. Emits `context_patch` to persist the
   * (new) session id — Shelf never touches the context store directly.
   */
  async function ensureSession(
    input: { cwd: string; appId?: string; resumeId?: string | null },
    send: SendFn | null,
  ): Promise<AcpSession> {
    if (session && sessionCwd === input.cwd) return session;
    const c = ensureConnection(input.cwd);
    const root = copilotAcpSkillsRoot(input.appId);
    const opts = { cwd: input.cwd, additionalDirectories: root ? [root] : undefined };

    if (input.resumeId) {
      try {
        session = await driver.resume(c.agent, input.resumeId, opts);
        sessionCwd = input.cwd;
        return session;
      } catch {
        // Resume rejected (session gone / unsupported) → fall through to new.
      }
    }
    session = await driver.startNew(c.agent, opts);
    sessionCwd = input.cwd;
    send?.({ type: 'context_patch', patch: { lastSdkSessionId: session.sessionId } });
    return session;
  }

  return {
    async query(input: QueryInput, send: SendFn): Promise<void> {
      currentSend = send;
      try {
        // Phase 1 skeleton: config edits (model/effort/mode) are a Phase-2 parity
        // item (apply via ACP set-config/set-mode). A config-edit turn carries no
        // prompt, so acknowledge and return rather than drive an empty prompt.
        if (input.configEdit) {
          send({
            type: 'message',
            msgId: `m-${randomUUID().slice(0, 8)}`,
            msgType: 'system',
            content: `acp-copilot: config edit (${input.configEdit.key}) not yet applied (Phase 2)`,
          });
          return;
        }
        const s = await ensureSession(
          { cwd: input.cwd, appId: input.appId, resumeId: input.restoreContext?.lastSdkSessionId },
          send,
        );
        await driver.drivePromptTurn(conn!.agent, s, input.prompt, send);
      } catch (err) {
        send({ type: 'error', error: `acp-copilot: ${(err as Error)?.message ?? String(err)}` });
      } finally {
        currentSend = null;
        send({ type: 'status', state: 'idle' });
      }
    },

    async gatherCapabilities(cwd: string): Promise<ProviderCapabilities> {
      try {
        const s = await ensureSession({ cwd }, null);
        const r = s.newSessionResponse;
        // Model/effort/mode are DYNAMIC (agent-owned config options) — mapped by
        // the shared toolkit, same as codex; copilot needs no bespoke mapping.
        // WithCurrent = also carry the active selections so the status bar renders
        // the current model/permission-mode (not just the option lists).
        return mapSessionCapabilitiesWithCurrent({ modes: r?.modes, configOptions: r?.configOptions });
      } catch {
        // A fresh session most commonly fails when unauthenticated → surface the
        // auth pane rather than an empty capability set.
        return { models: [], permissionModes: [], effortLevels: [], slashCommands: [], authRequired: true };
      }
    },

    resolvePermission(toolUseId: string, allow: boolean, message?: string, scope?: 'once' | 'session'): void {
      permissions.resolvePermission(toolUseId, allow, message, scope);
    },

    /**
     * Device-flow login, out-of-band from ACP: drive `copilot login` (same binary
     * as `copilot --acp`), surface the verification URL + code via
     * `auth_login_prompt`, and report the outcome via `auth_login_done`. The CLI
     * persists its own credentials; the ACP session reuses that ambient auth on
     * its next turn. Reuses native copilot's login drive (same CLI).
     */
    startLogin(_cwd: string, send: SendFn): void {
      loginRunner?.cancel();
      let cliPath: string;
      try {
        cliPath = resolveCopilotAcpCommand().command;
      } catch (err) {
        send({ type: 'auth_login_done', provider: COPILOT_ACP_PROVIDER, ok: false, error: (err as Error)?.message ?? String(err) });
        return;
      }
      loginRunner = startCopilotLogin({
        cliPath,
        onPrompt: (p) => send({
          type: 'auth_login_prompt',
          provider: COPILOT_ACP_PROVIDER,
          verificationUri: p.verificationUri,
          userCode: p.userCode,
          prefilledUri: prefillLoginUrl(p),
        }),
      });
      loginRunner.done.then((r) => send({
        type: 'auth_login_done',
        provider: COPILOT_ACP_PROVIDER,
        ok: r.ok,
        cancelled: r.cancelled,
        error: r.error,
      }));
    },

    cancelLogin(): void {
      loginRunner?.cancel();
      loginRunner = null;
    },

    async stop(): Promise<void> {
      // Cooperative cancel: tell the agent to abort the active turn.
      permissions.cancelAll();
      if (conn && session) {
        await conn.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
      }
    },

    resetSession(): void {
      if (session) driver.forget(session.sessionId);
      session = null;
      sessionCwd = null;
    },

    dispose(): void {
      loginRunner?.cancel();
      permissions.cancelAll();
      if (session) driver.forget(session.sessionId);
      try { conn?.close(); } catch { /* best-effort */ }
      try { child?.kill(); } catch { /* best-effort */ }
      conn = null;
      child = null;
      session = null;
      sessionCwd = null;
    },
  };
}
