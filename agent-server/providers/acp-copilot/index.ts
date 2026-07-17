// Copilot agent provider over ACP (ServerBackend), peer to createCodexBackend /
// createCopilotBackend (the native SDK one). Uses the shared, semantics-free
// acp/ toolkit for the runtime and OWNS copilot specifics (binary launch via
// `copilot --acp`, device-flow login, skills root). ACP is an internal detail;
// the provider identity is 'acp-copilot' (a PARALLEL, dev-gated backend that at
// cutover replaces native 'copilot' — see the copilot-acp feature note).

import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { methods, type Stream, type AgentApp, type SessionModeState, type SessionConfigOption } from '@agentclientprotocol/sdk';
import { formatConfigAck, type ConfigEditKey } from '@shared/config-ack';
import type { ServerBackend, QueryInput, SendFn, ProviderCapabilities } from '../types';
import { serverLog } from '../../server-logger';
import { openAcpConnection, spawnAgentStdio, type AcpConnection } from '../acp/connection';
import { createSessionDriver, type AcpSession } from '../acp/client';
import { createPermissionBridge } from '../acp/permission';
import { mapSessionCapabilities, currentSelections, configOptionIdForCategory } from '../acp/capabilities';
import { toAcpMcpServers } from '../acp/mcp';
import { loadProjectedMcpServers } from '../mcp-config';
import { resolveCopilotAcpCommand, copilotAcpSkillsRoot } from './helpers';
import { copilotPermissionModes, copilotModeIdToShelf, shelfToCopilotModeId } from './mode-map';
import { startLogin as startCopilotLogin, prefillLoginUrl, type LoginRunner } from '../copilot/login';

// Category names for copilot's dynamic config options (agent-owned), used to
// resolve the option id for session/set_config_option.
const MODEL_CATEGORY = 'model';
const EFFORT_CATEGORY = 'thought_level';

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
  // The appId the live session was created with — MCP servers + skills root are
  // fixed at session/new, so if appId is only learned later (gatherCapabilities
  // has no appId; the first `send` does), the session is recreated to pick them
  // up. undefined until known. Stable per app instance (getAppInstanceId).
  let sessionAppId: string | undefined;
  let lastAppId: string | undefined;
  // The active turn's send — the permission bridge rides this lane so requests
  // reach the renderer on the current turn's id.
  let currentSend: SendFn | null = null;
  let loginRunner: LoginRunner | null = null;
  const permissions = createPermissionBridge(() => currentSend);
  const driver = createSessionDriver();

  // Live session config (cached from the last new-session response) + the active
  // selections in SHELF vocabulary. Seeded from the renderer's saved prefs (intent)
  // and the agent's advertised current values; kept in sync as edits apply.
  let sessionModes: SessionModeState | undefined;
  let sessionConfigOptions: SessionConfigOption[] | undefined;
  let currentModel: string | undefined;
  let currentEffort: string | undefined;
  let currentPermissionMode: string | undefined; // Shelf id (default/plan/bypassPermissions)

  /** Caps from the live session config + the active current* selections, ready to
   *  spread into a `capabilities` wire message. permissionModes are the Shelf-
   *  standard set (matches native copilot), NOT copilot's raw agent/plan/autopilot. */
  function buildCapabilities(): ProviderCapabilities {
    const input = { modes: sessionModes, configOptions: sessionConfigOptions };
    const base = mapSessionCapabilities(input);
    return {
      ...base,
      permissionModes: copilotPermissionModes(),
      ...(currentModel ? { currentModel } : {}),
      ...(currentEffort ? { currentEffort } : {}),
      ...(currentPermissionMode ? { currentPermissionMode } : {}),
    };
  }

  async function applyModel(model: string): Promise<void> {
    currentModel = model;
    const configId = configOptionIdForCategory(sessionConfigOptions, MODEL_CATEGORY);
    if (conn && session && configId) await driver.setConfigOption(conn.agent, session, configId, model);
    else if (conn && session) serverLog('warn', 'acp-copilot', `setModel: no model config option on session ${session.sessionId}`);
  }

  async function applyEffort(effort: string): Promise<void> {
    currentEffort = effort;
    const configId = configOptionIdForCategory(sessionConfigOptions, EFFORT_CATEGORY);
    if (conn && session && configId) await driver.setConfigOption(conn.agent, session, configId, effort);
    else if (conn && session) serverLog('warn', 'acp-copilot', `setEffort: no thought_level config option on session ${session.sessionId}`);
  }

  async function applyPermissionMode(mode: string): Promise<void> {
    currentPermissionMode = mode;
    const modeId = shelfToCopilotModeId(mode, sessionModes);
    if (conn && session && modeId) await driver.setMode(conn.agent, session, modeId);
    else if (conn && session) serverLog('warn', 'acp-copilot', `setPermissionMode: copilot has no mode for "${mode}"`);
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
    // appId is stable per app instance; gatherCapabilities lacks it, the first
    // send carries it. Resolve against the last-seen value.
    if (input.appId) lastAppId = input.appId;
    const appId = input.appId ?? lastAppId;
    // Reuse only if cwd AND the MCP/skills context (appId) are unchanged — else
    // recreate so app-level MCP servers + skills root take effect at session/new.
    if (session && sessionCwd === input.cwd && sessionAppId === appId) return session;
    if (session) driver.forget(session.sessionId);

    const c = ensureConnection(input.cwd);
    const root = copilotAcpSkillsRoot(appId);
    const mcp = loadProjectedMcpServers(appId);
    // Fail-loud: a bad/incomplete MCP entry is logged, not silently dropped.
    for (const e of mcp.errors) serverLog('warn', 'acp-copilot', `MCP config: ${e}`);
    const opts = {
      cwd: input.cwd,
      additionalDirectories: root ? [root] : undefined,
      mcpServers: toAcpMcpServers(mcp.servers),
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
    // Cache the advertised config so set-mode / set-config-option can resolve ids
    // and buildCapabilities() has the option lists.
    sessionModes = session.newSessionResponse?.modes ?? undefined;
    sessionConfigOptions = session.newSessionResponse?.configOptions ?? undefined;
    send?.({ type: 'context_patch', patch: { lastSdkSessionId: session.sessionId } });
    return session;
  }

  return {
    async query(input: QueryInput, send: SendFn): Promise<void> {
      currentSend = send;
      try {
        // A config-edit turn (picker / status-bar) carries no prompt — apply it
        // imperatively (set-mode / set-config-option) and return, rather than
        // driving an empty prompt. Prompt-turn pref changes go via the imperative
        // setters (orchestrator applyPrefDiff), not here.
        if (input.configEdit) {
          await ensureSession({ cwd: input.cwd, appId: input.appId, resumeId: input.restoreContext?.lastSdkSessionId }, send);
          await applyConfigEdit(input.configEdit.key, input.configEdit.value, send);
          return;
        }
        const s = await ensureSession(
          { cwd: input.cwd, appId: input.appId, resumeId: input.restoreContext?.lastSdkSessionId },
          send,
        );
        await driver.drivePromptTurn(conn!.agent, s, input.prompt, send, input.images);
      } catch (err) {
        send({ type: 'error', error: `acp-copilot: ${(err as Error)?.message ?? String(err)}` });
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
    ): Promise<ProviderCapabilities> {
      // Seed current* from the renderer's saved prefs BEFORE building caps, so the
      // first reported values reflect the user's choice rather than the agent's
      // default (matches the ServerBackend `intent` contract).
      if (intent?.model) currentModel = intent.model;
      if (intent?.effort) currentEffort = intent.effort;
      if (intent?.permissionMode) currentPermissionMode = intent.permissionMode;
      try {
        await ensureSession({ cwd }, null);
        // Fill any current* the renderer didn't pin from the agent's live values.
        const cur = currentSelections({ modes: sessionModes, configOptions: sessionConfigOptions });
        currentModel ??= cur.currentModel;
        currentEffort ??= cur.currentEffort;
        currentPermissionMode ??= copilotModeIdToShelf(sessionModes?.currentModeId);
        return buildCapabilities();
      } catch {
        // A fresh session most commonly fails when unauthenticated → surface the
        // auth pane rather than an empty capability set.
        return { models: [], permissionModes: [], effortLevels: [], slashCommands: [], authRequired: true };
      }
    },

    setModel(model: string): Promise<void> { return applyModel(model); },
    setEffort(effort: string): Promise<void> { return applyEffort(effort); },
    setPermissionMode(mode: string): Promise<void> { return applyPermissionMode(mode); },

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
