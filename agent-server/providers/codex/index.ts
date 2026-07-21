// Codex agent provider (ServerBackend), peer to createClaudeBackend /
// createCopilotBackend. Uses the shared, semantics-free acp/ toolkit for the
// runtime and OWNS codex specifics (binary launch, skills root, and — later —
// modes, model format, device-code auth). ACP is an internal detail; the
// provider identity is 'codex'.

import type { ChildProcess } from 'node:child_process';
import { methods, type Stream, type AgentApp } from '@agentclientprotocol/sdk';
import type { ServerBackend, QueryInput, SendFn, ProviderCapabilities } from '../types';
import { openAcpConnection, spawnAgentStdio, type AcpConnection } from '../acp/connection';
import { createSessionDriver, type AcpSession } from '../acp/client';
import { createPermissionBridge } from '../acp/permission';
import { mapSessionCapabilitiesWithCurrent } from '../acp/capabilities';
import { toAcpMcpServers } from '../acp/mcp';
import { getSharedShelfMcp } from '../acp/shelf-mcp';
import { loadProjectedMcpServers } from '../mcp-config';
import { serverLog } from '../../server-logger';
import { resolveCodexAcpCommand, codexSkillsRoot, codexSkillTarget } from './helpers';
import { driveDeviceCodeLogin, spawnCodexAppServerRpc, type LoginHandle } from './app-server-login';

/** What to connect the ACP client to + the child to reap (production spawns a
 *  codex-acp process; tests inject an in-process mock AgentApp). Mirrors the
 *  copilot-acp seam so the codex backend is unit-testable with a mock agent. */
export interface CodexAgentTarget {
  target: Stream | AgentApp;
  child?: ChildProcess;
}

export interface CodexDeps {
  /** Open the agent transport for `cwd`. Default: spawn codex-acp. */
  openAgent?: (cwd: string) => CodexAgentTarget;
  /** Resolve the in-process Shelf MCP bridge (level 1). Default: the shared HTTP
   *  server. Return null to omit it (tests skip starting a real HTTP server). */
  getShelfMcp?: () => Promise<{ url: string } | null>;
}

function defaultOpenAgent(cwd: string): CodexAgentTarget {
  const { command, args } = resolveCodexAcpCommand();
  const spawned = spawnAgentStdio(command, args, { cwd });
  return { target: spawned.stream, child: spawned.child };
}

export function createCodexBackend(deps: CodexDeps = {}): ServerBackend {
  const openAgent = deps.openAgent ?? defaultOpenAgent;
  const getShelfMcp = deps.getShelfMcp ?? getSharedShelfMcp;

  let conn: AcpConnection | null = null;
  let child: ChildProcess | null = null;
  let session: AcpSession | null = null;
  let sessionCwd: string | null = null;
  // The appId the live session was created with — MCP servers + skills root are
  // fixed at session/new; gatherCapabilities has no appId, the first send does,
  // so the session is recreated once appId is learned. Stable per app instance.
  let sessionAppId: string | undefined;
  let lastAppId: string | undefined;
  // The active turn's send — the permission bridge rides this lane so requests
  // reach the renderer on the current turn's id.
  let currentSend: SendFn | null = null;
  let loginHandle: LoginHandle | null = null;
  const permissions = createPermissionBridge(() => currentSend);
  const driver = createSessionDriver();

  /** Spawn codex-acp + open the ACP connection once; reused across turns. */
  function ensureConnection(cwd: string): AcpConnection {
    if (conn) return conn;
    const opened = openAgent(cwd);
    child = opened.child ?? null;
    conn = openAcpConnection(opened.target, {
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
    // appId is stable per app instance; gatherCapabilities lacks it, the first
    // send carries it. Resolve against the last-seen value and recreate the
    // session when it changes so app-level MCP servers + skills root take effect.
    if (input.appId) lastAppId = input.appId;
    const appId = input.appId ?? lastAppId;
    if (session && sessionCwd === input.cwd && sessionAppId === appId) return session;
    if (session) driver.forget(session.sessionId);

    const c = ensureConnection(input.cwd);
    const root = codexSkillsRoot(appId);
    const mcp = loadProjectedMcpServers(appId);
    for (const e of mcp.errors) serverLog('warn', 'codex', `MCP config: ${e}`);
    // Level 1 (Shelf built-in bridge) + level 2 (user MCP) coexist as mcpServers
    // entries — same as copilot-acp/claude. The shelf bridge is an in-process HTTP
    // MCP server (acp/shelf-mcp.ts); without it codex has no app-level bridge tools
    // (app_skill CRUD, web_fetch, browser_open).
    const shelf = await getShelfMcp();
    const opts = {
      cwd: input.cwd,
      additionalDirectories: root ? [root] : undefined,
      mcpServers: [
        ...toAcpMcpServers(mcp.servers),
        ...(shelf ? [{ type: 'http' as const, name: 'shelf', url: shelf.url, headers: [] }] : []),
      ],
    };

    if (input.resumeId) {
      try {
        session = await driver.resume(c.agent, input.resumeId, opts);
        sessionCwd = input.cwd;
        sessionAppId = appId;
        return session;
      } catch {
        // Resume rejected (session gone / unsupported) → fall through to new.
      }
    }
    session = await driver.startNew(c.agent, opts);
    sessionCwd = input.cwd;
    sessionAppId = appId;
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
        await driver.drivePromptTurn(conn!.agent, s, input.prompt, send, input.images);
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
        // `available_commands_update` arrives out-of-turn just AFTER session/new,
        // so briefly wait (bounded) for it — else slash autocomplete is empty on
        // the first caps fetch. Resolves as soon as it lands (~a few ms). Mirrors
        // copilot-acp.
        for (let i = 0; i < 20 && !driver.getAvailableCommands(s.sessionId); i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        const r = s.newSessionResponse;
        // Model list is DYNAMIC (agent-owned config options) — no Shelf registry.
        // WithCurrent so the status bar shows the active model/effort/mode (not
        // just the option lists). Permission modes are codex's raw advertised
        // modes for now — a Shelf-semantic mapping is the config-edit task (T4.1-A).
        return mapSessionCapabilitiesWithCurrent({
          modes: r?.modes,
          configOptions: r?.configOptions,
          availableCommands: driver.getAvailableCommands(s.sessionId),
        });
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

    skillTarget(appId: string | undefined): string | undefined {
      return codexSkillTarget(appId);
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
