// Codex agent provider (ServerBackend), peer to createClaudeBackend /
// createCopilotBackend. Uses the shared, semantics-free acp/ toolkit for the
// runtime and OWNS codex specifics (binary launch, skills root, and — later —
// modes, model format, device-code auth). ACP is an internal detail; the
// provider identity is 'codex'.

import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { methods, type Stream, type AgentApp, type SessionModeState, type SessionConfigOption } from '@agentclientprotocol/sdk';
import { formatConfigAck, type ConfigEditKey } from '@shared/config-ack';
import type { ServerBackend, QueryInput, SendFn, ProviderCapabilities } from '../types';
import { openAcpConnection, spawnAgentStdio, type AcpConnection } from '../acp/connection';
import { createSessionDriver, type AcpSession } from '../acp/client';
import { createPermissionBridge } from '../acp/permission';
import { mapSessionCapabilities, currentSelections, configOptionIdForCategory } from '../acp/capabilities';
import { toAcpMcpServers } from '../acp/mcp';
import { getSharedShelfMcp } from '../acp/shelf-mcp';
import { loadProjectedMcpServers } from '../mcp-config';
import { serverLog } from '../../server-logger';
import { resolveCodexAcpCommand, codexSkillsRoot, codexSkillTarget, codexAcpEnv, codexConfigHome } from './helpers';
import { codexPermissionModes, codexModeIdToShelf, shelfToCodexModeId, codexUnmappedModeIds } from './mode-map';
import { driveDeviceCodeLogin, spawnCodexAppServerRpc, type LoginHandle } from './app-server-login';

// Category names for codex's dynamic config options (agent-owned) — SAME as
// copilot (verified from codex-acp: category `model` / `thought_level`).
const MODEL_CATEGORY = 'model';
const EFFORT_CATEGORY = 'thought_level';

// oauth authMethod for the unauthenticated caps return — WITHOUT it the AuthPane
// (gated on `authMethod.kind === 'oauth'`) renders no Login button, so codex's
// device-code login can't be started. codex advertises both api-key and chat-gpt
// ACP authMethods; the device-code (ChatGPT) path is the one Shelf drives (see
// startLogin), so the backend declares it as the primary oauth method.
const CODEX_AUTH_METHOD = {
  kind: 'oauth' as const,
  instructions: [{ label: 'Sign in with your ChatGPT account (device code)' }],
};

/** What to connect the ACP client to + the child to reap (production spawns a
 *  codex-acp process; tests inject an in-process mock AgentApp). Mirrors the
 *  copilot-acp seam so the codex backend is unit-testable with a mock agent. */
export interface CodexAgentTarget {
  target: Stream | AgentApp;
  child?: ChildProcess;
}

export interface CodexDeps {
  /** Open the agent transport for `cwd`. `appId` selects the per-app `CODEX_HOME`
   *  (device-scoped auth isolation). Default: spawn codex-acp. */
  openAgent?: (cwd: string, appId?: string) => CodexAgentTarget;
  /** Resolve the in-process Shelf MCP bridge (level 1). Default: the shared HTTP
   *  server. Return null to omit it (tests skip starting a real HTTP server). */
  getShelfMcp?: () => Promise<{ url: string } | null>;
}

function defaultOpenAgent(cwd: string, appId?: string): CodexAgentTarget {
  const { command, args } = resolveCodexAcpCommand();
  // CODEX_HOME (per-app config-home) is set at SPAWN — process env, so it must be
  // right from the start (auth lives under it). appId is known by caps-time.
  const spawned = spawnAgentStdio(command, args, { cwd, env: codexAcpEnv(appId) });
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
  // The appId the live CONNECTION (process) was spawned for. CODEX_HOME is fixed at
  // spawn, so a change here forces a process respawn (not just a new session).
  let connAppId: string | undefined;
  // The active turn's send — the permission bridge rides this lane so requests
  // reach the renderer on the current turn's id.
  let currentSend: SendFn | null = null;
  let loginHandle: LoginHandle | null = null;
  const permissions = createPermissionBridge(() => currentSend);
  const driver = createSessionDriver();

  // Live session config (cached from the last new-session response) + the active
  // selections in SHELF vocabulary, kept in sync as edits apply (mirrors copilot-acp).
  let sessionModes: SessionModeState | undefined;
  let sessionConfigOptions: SessionConfigOption[] | undefined;
  let currentModel: string | undefined;
  let currentEffort: string | undefined;
  let currentPermissionMode: string | undefined; // Shelf id (default/plan/bypassPermissions)

  /** Caps from the live session config + current* selections. permissionModes are
   *  codex's advertised modes mapped to Shelf vocabulary (see mode-map). */
  function buildCapabilities(): ProviderCapabilities {
    const availableCommands = session ? driver.getAvailableCommands(session.sessionId) : undefined;
    const base = mapSessionCapabilities({ modes: sessionModes, configOptions: sessionConfigOptions, availableCommands });
    // Fail-loud: a codex mode we can't map is dropped from the picker — log it as a
    // candidate for a new Shelf permission mode (integration policy).
    for (const id of codexUnmappedModeIds(sessionModes)) {
      serverLog('warn', 'codex', `unmapped permission mode "${id}" — hidden from the picker (candidate for a new Shelf mode)`);
    }
    return {
      ...base,
      permissionModes: codexPermissionModes(sessionModes),
      ...(currentModel ? { currentModel } : {}),
      ...(currentEffort ? { currentEffort } : {}),
      ...(currentPermissionMode ? { currentPermissionMode } : {}),
    };
  }

  async function applyModel(model: string): Promise<void> {
    currentModel = model;
    const configId = configOptionIdForCategory(sessionConfigOptions, MODEL_CATEGORY);
    if (conn && session && configId) await driver.setConfigOption(conn.agent, session, configId, model);
    else if (conn && session) serverLog('warn', 'codex', `setModel: no model config option on session ${session.sessionId}`);
  }

  async function applyEffort(effort: string): Promise<void> {
    currentEffort = effort;
    const configId = configOptionIdForCategory(sessionConfigOptions, EFFORT_CATEGORY);
    if (conn && session && configId) await driver.setConfigOption(conn.agent, session, configId, effort);
    else if (conn && session) serverLog('warn', 'codex', `setEffort: no thought_level config option on session ${session.sessionId}`);
  }

  async function applyPermissionMode(mode: string): Promise<void> {
    currentPermissionMode = mode;
    const modeId = shelfToCodexModeId(mode, sessionModes);
    if (conn && session && modeId) await driver.setMode(conn.agent, session, modeId);
    else if (conn && session) serverLog('warn', 'codex', `setPermissionMode: codex has no mode for "${mode}"`);
  }

  /** Apply a config-edit turn (picker / status-bar): imperative apply + updated
   *  capabilities + an ack divider. No-op guard skips a re-pick of the live value. */
  async function applyConfigEdit(key: ConfigEditKey, value: string, send: SendFn): Promise<void> {
    const cur = key === 'model' ? currentModel : key === 'effort' ? currentEffort : currentPermissionMode;
    if (cur === value) return;
    try {
      if (key === 'model') await applyModel(value);
      else if (key === 'effort') await applyEffort(value);
      else await applyPermissionMode(value);
      send({ type: 'capabilities', ...buildCapabilities() });
      send({ type: 'message', msgId: `m-${randomUUID().slice(0, 8)}`, msgType: 'system', content: formatConfigAck(key, value) });
    } catch (err) {
      send({ type: 'message', msgId: `m-${randomUUID().slice(0, 8)}`, msgType: 'error', content: `Failed to set ${key}: ${(err as Error)?.message ?? String(err)}` });
    }
  }

  /** Spawn codex-acp (with the per-app CODEX_HOME) + open the ACP connection once. */
  function ensureConnection(cwd: string, appId: string | undefined): AcpConnection {
    if (conn) return conn;
    const opened = openAgent(cwd, appId);
    child = opened.child ?? null;
    connAppId = appId;
    conn = openAcpConnection(opened.target, {
      name: 'shelf-codex',
      onRequestPermission: permissions.onRequestPermission,
      onSessionUpdate: driver.onSessionUpdate,
    });
    // Drop refs when the agent process/connection ends so the next turn respawns —
    // but ONLY if we are STILL the live connection. reconnect()/appId-respawn close
    // the old connection and immediately spawn a new one; the OLD conn's `closed`
    // resolves later (on real child exit) and MUST NOT clobber the NEW refs (would
    // leak the new process + force a redundant respawn). Identity-guarded, mirroring
    // the dispatcher's SessionChannel.kill guard.
    const thisConn = conn;
    conn.closed.finally(() => {
      if (conn !== thisConn) return;
      conn = null;
      child = null;
      connAppId = undefined;
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

    // CODEX_HOME is fixed at spawn. If the live connection was spawned for a
    // DIFFERENT appId (e.g. a legacy caps call that lacked appId), tear it down so
    // it respawns with the right config-home. Normally a no-op (appId rides caps).
    if (conn && connAppId !== appId) {
      serverLog('debug', 'codex', `appId changed (${String(connAppId).slice(0, 8)} → ${String(appId).slice(0, 8)}) — respawning connection for CODEX_HOME`);
      try { conn.close(); } catch { /* best-effort */ }
      conn = null; child = null; connAppId = undefined; session = null; sessionCwd = null;
    }

    if (session && sessionCwd === input.cwd && sessionAppId === appId) return session;
    if (session) driver.forget(session.sessionId);

    const c = ensureConnection(input.cwd, appId);
    // ACP requires the `initialize` handshake before any session op; codex-acp
    // rejects session/new with "Not initialized" otherwise. openAcpConnection fired
    // it on open — await it here (overlaps the MCP/skill setup below).
    await c.initialized;
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
    // Cache advertised config so set-mode / set-config-option can resolve ids and
    // buildCapabilities() has the option lists.
    sessionModes = session.newSessionResponse?.modes ?? undefined;
    sessionConfigOptions = session.newSessionResponse?.configOptions ?? undefined;
    // Persist the SDK session id so the next process can resume it.
    send?.({ type: 'context_patch', patch: { lastSdkSessionId: session.sessionId } });
    return session;
  }

  return {
    async query(input: QueryInput, send: SendFn): Promise<void> {
      currentSend = send;
      try {
        // A config-edit turn (picker / status-bar) carries no prompt — apply it
        // imperatively and return, rather than driving an empty prompt.
        if (input.configEdit) {
          await ensureSession({ cwd: input.cwd, appId: input.appId, resumeId: input.restoreContext?.lastSdkSessionId }, send);
          await applyConfigEdit(input.configEdit.key, input.configEdit.value, send);
          return;
        }
        const s = await ensureSession(
          { cwd: input.cwd, appId: input.appId, resumeId: input.restoreContext?.lastSdkSessionId },
          send,
        );
        await driver.drivePromptTurn(conn!.agent, s, input.prompt, send, input.images, input.attachments);
      } catch (err) {
        send({ type: 'error', error: `codex: ${(err as Error)?.message ?? String(err)}` });
      } finally {
        currentSend = null;
        send({ type: 'status', state: 'idle' });
      }
    },

    async gatherCapabilities(
      cwd: string,
      _sessionId?: string,
      _customModels?: unknown,
      intent?: { model?: string; effort?: string; permissionMode?: string },
      _cache?: unknown,
      appId?: string,
    ): Promise<ProviderCapabilities> {
      // appId rides caps → the codex-acp spawn below already gets the per-app
      // CODEX_HOME (device-scoped auth isolation), and login (which follows caps)
      // reuses it via lastAppId.
      if (appId) lastAppId = appId;
      // Seed current* from the renderer's saved prefs BEFORE building caps, so the
      // first reported values reflect the user's choice, not the agent default.
      if (intent?.model) currentModel = intent.model;
      if (intent?.effort) currentEffort = intent.effort;
      if (intent?.permissionMode) currentPermissionMode = intent.permissionMode;
      try {
        const s = await ensureSession({ cwd, appId }, null);
        // `available_commands_update` arrives out-of-turn just AFTER session/new,
        // so briefly wait (bounded) for it — else slash autocomplete is empty on
        // the first caps fetch. Mirrors copilot-acp.
        for (let i = 0; i < 20 && !driver.getAvailableCommands(s.sessionId); i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        // Fill any current* the renderer didn't pin from the agent's live values;
        // the permission mode is mapped codex → Shelf vocabulary.
        const cur = currentSelections({ modes: sessionModes, configOptions: sessionConfigOptions });
        currentModel ??= cur.currentModel;
        currentEffort ??= cur.currentEffort;
        currentPermissionMode ??= codexModeIdToShelf(sessionModes?.currentModeId);
        return buildCapabilities();
      } catch (err: any) {
        // A fresh codex session most commonly fails when unauthenticated →
        // surface the auth pane rather than an empty capability set. authMethod
        // drives the AuthPane's Login button (oauth branch); without it the pane
        // shows no way to start the device-code login. FAIL-LOUD: log the real
        // session/new failure — this is a CATCH-ALL (any error → authRequired), so
        // without the message a NON-auth failure (config/MCP/timeout) is silently
        // mislabeled as "needs login". (T4.0 will refine to inspect the ACP
        // auth_required error specifically.)
        serverLog('warn', 'codex', `gatherCapabilities failed → reporting authRequired: ${err?.message ?? String(err)}`);
        return { models: [], permissionModes: [], effortLevels: [], slashCommands: [], authRequired: true, authMethod: CODEX_AUTH_METHOD };
      }
    },

    setModel(model: string): Promise<void> { return applyModel(model); },
    setEffort(effort: string): Promise<void> { return applyEffort(effort); },
    setPermissionMode(mode: string): Promise<void> { return applyPermissionMode(mode); },

    resolvePermission(toolUseId: string, allow: boolean, message?: string, scope?: 'once' | 'session'): void {
      permissions.resolvePermission(toolUseId, allow, message, scope);
    },

    /**
     * Subscription auth (device-code), out-of-band from ACP: drive codex's
     * app-server login, surface the URL + code via `auth_login_prompt`, and
     * report the outcome via `auth_login_done`. Codex persists its own credentials
     * (Shelf touches no file) under the per-app `CODEX_HOME` — the SAME config-home
     * the `--acp` session reads, so the device authorization sticks. lastAppId is
     * set by the preceding caps call (auth pane only shows after caps).
     */
    startLogin(_cwd: string, send: SendFn): void {
      loginHandle?.cancel();
      if (!lastAppId) serverLog('warn', 'codex', 'startLogin: appId unknown — login will use the default CODEX_HOME, not the per-app dir');
      const { rpc } = spawnCodexAppServerRpc(codexAcpEnv(lastAppId));
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

    /** codex-acp reads auth/config/sessions from CODEX_HOME; it errors if the dir
     *  doesn't pre-exist. The agent-server mkdirs this before spawning (the backend
     *  does no fs). Same path as the CODEX_HOME env (codexAcpEnv). */
    configHome(appId: string | undefined): string | undefined {
      return codexConfigHome(appId);
    },

    resetSession(): void {
      if (session) driver.forget(session.sessionId);
      session = null;
      sessionCwd = null;
    },

    /** Drop the live connection (process + session) so the next turn respawns and
     *  re-reads the per-app CODEX_HOME credentials a device-login just wrote. Mirrors
     *  the appId-change respawn in ensureSession, minus the appId check. */
    reconnect(): void {
      if (session) driver.forget(session.sessionId);
      try { conn?.close(); } catch { /* best-effort */ }
      try { child?.kill(); } catch { /* best-effort */ }
      conn = null;
      child = null;
      connAppId = undefined;
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
