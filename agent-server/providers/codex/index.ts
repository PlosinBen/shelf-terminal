// Codex agent provider (ServerBackend), peer to createClaudeBackend /
// createCopilotBackend. Uses the shared, semantics-free acp/ toolkit for the
// runtime and OWNS codex specifics (binary launch, skills root, and — later —
// modes, model format, device-code auth). ACP is an internal detail; the
// provider identity is 'codex'.

import type { ChildProcess } from 'node:child_process';
import { methods } from '@agentclientprotocol/sdk';
import type { ServerBackend, QueryInput, SendFn, ProviderCapabilities } from '../types';
import { openAcpConnection, spawnAgentStdio, type AcpConnection } from '../acp/connection';
import { createSessionDriver, type AcpSession } from '../acp/client';
import { createPermissionBridge } from '../acp/permission';
import { mapSessionCapabilities } from '../acp/capabilities';
import { resolveCodexAcpCommand, codexSkillsRoot } from './helpers';
import { driveDeviceCodeLogin, spawnCodexAppServerRpc, type LoginHandle } from './app-server-login';

export function createCodexBackend(): ServerBackend {
  let conn: AcpConnection | null = null;
  let child: ChildProcess | null = null;
  let session: AcpSession | null = null;
  let sessionCwd: string | null = null;
  // The active turn's send — the permission bridge rides this lane so requests
  // reach the renderer on the current turn's id.
  let currentSend: SendFn | null = null;
  let loginHandle: LoginHandle | null = null;
  const permissions = createPermissionBridge(() => currentSend);
  const driver = createSessionDriver();

  /** Spawn codex-acp + open the ACP connection once; reused across turns. */
  function ensureConnection(cwd: string): AcpConnection {
    if (conn) return conn;
    const { command, args } = resolveCodexAcpCommand();
    const spawned = spawnAgentStdio(command, args, { cwd });
    child = spawned.child;
    conn = openAcpConnection(spawned.stream, {
      name: 'shelf-codex',
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
  async function ensureSession(input: { cwd: string; appId?: string; resumeId?: string | null }, send: SendFn | null): Promise<AcpSession> {
    if (session && sessionCwd === input.cwd) return session;
    const c = ensureConnection(input.cwd);
    const root = codexSkillsRoot(input.appId);
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
    // Persist the SDK session id so the next process can resume it.
    send?.({ type: 'context_patch', patch: { lastSdkSessionId: session.sessionId } });
    return session;
  }

  return {
    async query(input: QueryInput, send: SendFn): Promise<void> {
      currentSend = send;
      try {
        const s = await ensureSession(
          { cwd: input.cwd, appId: input.appId, resumeId: input.restoreContext?.lastSdkSessionId },
          send,
        );
        await driver.drivePromptTurn(conn!.agent, s, input.prompt, send);
      } catch (err) {
        send({ type: 'error', error: `codex: ${(err as Error)?.message ?? String(err)}` });
      } finally {
        currentSend = null;
        send({ type: 'status', state: 'idle' });
      }
    },

    async gatherCapabilities(cwd: string): Promise<ProviderCapabilities> {
      try {
        const s = await ensureSession({ cwd }, null);
        const r = s.newSessionResponse;
        // Model list is DYNAMIC (agent-owned config options) — no Shelf registry.
        return mapSessionCapabilities({ modes: r?.modes, configOptions: r?.configOptions });
      } catch {
        // A fresh codex session most commonly fails when unauthenticated →
        // surface the auth pane rather than an empty capability set. (T4.0 will
        // refine to inspect the ACP auth_required error specifically.)
        return { models: [], permissionModes: [], effortLevels: [], slashCommands: [], authRequired: true };
      }
    },

    resolvePermission(toolUseId: string, allow: boolean, message?: string, scope?: 'once' | 'session'): void {
      permissions.resolvePermission(toolUseId, allow, message, scope);
    },

    /**
     * Subscription auth (device-code), out-of-band from ACP: drive codex's
     * app-server login, surface the URL + code via `auth_login_prompt`, and
     * report the outcome via `auth_login_done`. Codex persists its own
     * credentials to `~/.codex` (Shelf touches no file); the codex-acp session
     * then reuses that ambient auth on its next turn.
     */
    startLogin(_cwd: string, send: SendFn): void {
      loginHandle?.cancel();
      const { rpc } = spawnCodexAppServerRpc();
      loginHandle = driveDeviceCodeLogin(rpc, send);
    },

    cancelLogin(): void {
      loginHandle?.cancel();
      loginHandle = null;
    },

    async stop(): Promise<void> {
      // Cooperative cancel: tell the agent to abort the active turn. The prompt
      // then resolves with stopReason 'cancelled' and query()'s finally emits idle.
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
