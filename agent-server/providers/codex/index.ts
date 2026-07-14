// Codex agent provider (ServerBackend), peer to createClaudeBackend /
// createCopilotBackend. Uses the shared, semantics-free acp/ toolkit for the
// runtime and OWNS codex specifics (binary launch, skills root, and — later —
// modes, model format, device-code auth). ACP is an internal detail; the
// provider identity is 'codex'.

import type { ChildProcess } from 'node:child_process';
import { methods, type ActiveSession } from '@agentclientprotocol/sdk';
import type { ServerBackend, QueryInput, SendFn } from '../types';
import { openAcpConnection, spawnAgentStdio, type AcpConnection } from '../acp/connection';
import { startSession, drivePromptTurn } from '../acp/client';
import { createPermissionBridge } from '../acp/permission';
import { resolveCodexAcpCommand, codexSkillsRoot } from './helpers';

export function createCodexBackend(): ServerBackend {
  let conn: AcpConnection | null = null;
  let child: ChildProcess | null = null;
  let session: ActiveSession | null = null;
  let sessionCwd: string | null = null;
  // The active turn's send — the permission bridge rides this lane so requests
  // reach the renderer on the current turn's id.
  let currentSend: SendFn | null = null;
  const permissions = createPermissionBridge(() => currentSend);

  /** Spawn codex-acp + open the ACP connection once; reused across turns. */
  function ensureConnection(cwd: string): AcpConnection {
    if (conn) return conn;
    const { command, args } = resolveCodexAcpCommand();
    const spawned = spawnAgentStdio(command, args, { cwd });
    child = spawned.child;
    conn = openAcpConnection(spawned.stream, {
      name: 'shelf-codex',
      onRequestPermission: permissions.onRequestPermission,
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

  async function ensureSession(cwd: string, appId: string | undefined): Promise<ActiveSession> {
    if (session && sessionCwd === cwd) return session;
    const c = ensureConnection(cwd);
    const root = codexSkillsRoot(appId);
    session = await startSession(c.agent, {
      cwd,
      additionalDirectories: root ? [root] : undefined,
    });
    sessionCwd = cwd;
    return session;
  }

  return {
    async query(input: QueryInput, send: SendFn): Promise<void> {
      currentSend = send;
      try {
        const s = await ensureSession(input.cwd, input.appId);
        await drivePromptTurn(s, input.prompt, send);
      } catch (err) {
        send({ type: 'error', error: `codex: ${(err as Error)?.message ?? String(err)}` });
      } finally {
        currentSend = null;
        send({ type: 'status', state: 'idle' });
      }
    },

    resolvePermission(toolUseId: string, allow: boolean, message?: string, scope?: 'once' | 'session'): void {
      permissions.resolvePermission(toolUseId, allow, message, scope);
    },

    async stop(): Promise<void> {
      // Cooperative cancel: tell the agent to abort the active turn. The prompt
      // then resolves with stopReason 'cancelled' and query()'s finally emits idle.
      permissions.cancelAll();
      if (conn && session) {
        await conn.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
      }
    },

    dispose(): void {
      permissions.cancelAll();
      try { session?.dispose(); } catch { /* best-effort */ }
      try { conn?.close(); } catch { /* best-effort */ }
      try { child?.kill(); } catch { /* best-effort */ }
      conn = null;
      child = null;
      session = null;
      sessionCwd = null;
    },
  };
}
