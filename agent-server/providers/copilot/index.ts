// Copilot agent provider over ACP (ServerBackend), peer to createCodexBackend.
// Uses the shared, semantics-free acp/ toolkit for the runtime and OWNS copilot
// specifics (binary launch via `copilot --acp`, device-flow login, config-home).
// ACP is an internal detail; the provider identity is 'copilot'. (This IS the
// copilot backend post-cutover — the pre-ACP native SDK backend was deleted.)

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  methods,
  type Stream,
  type AgentApp,
  type SessionModeState,
  type SessionConfigOption,
  type StopReason,
} from '@agentclientprotocol/sdk';
import { COPILOT_PROVIDER } from '@shared/agent-providers';
import { PERMISSION_CONTROL_STRATEGIES, type PermissionControlCapabilities } from '@shared/permission-controls';
import { CONFIG_EDIT_KEYS, formatConfigAck, type ConfigEditKey } from '@shared/config-ack';
import { type ServerBackend, type QueryInput, type SendFn, type ProviderCapabilities } from '../types';
import { serverLog } from '../../server-logger';
import { openAcpConnection, spawnAgentStdio, type AcpConnection, type PermissionHandler } from '../acp/connection';
import { createSessionDriver, type AcpSession } from '../acp/client';
import { createPermissionBridge } from '../acp/permission';
import { mapSessionCapabilities, currentSelections, configOptionIdForCategory } from '../acp/capabilities';
import { toAcpMcpServers } from '../acp/mcp';
import { getSharedShelfMcp } from '../acp/shelf-mcp';
import { loadProjectedMcpServers } from '../mcp-config';
import { resolveCopilotCommand, copilotConfigHome, copilotEnv } from './helpers';
import { refreshCopilotCredit } from './credit';
import { startLogin as startCopilotLogin, prefillLoginUrl, type LoginRunner } from './login';

// Category names for copilot's dynamic config options (agent-owned), used to
// resolve the option id for session/set_config_option.
const MODEL_CATEGORY = 'model';
const EFFORT_CATEGORY = 'thought_level';
const COPILOT_PERMISSION_OPTION_ID = 'allow_all';

// oauth authMethod for the unauthenticated caps return — WITHOUT it the AuthPane
// (gated on `authMethod.kind === 'oauth'`) renders no Login button, so device-flow
// login can't be started. Mirrors CLAUDE_AUTH_METHOD and the deleted native-copilot
// const (dropped in the ACP cutover — this restores it). The `instructions` ride the
// pane as fallback hints (headless remotes authenticate via a token env var instead).
const COPILOT_AUTH_METHOD = {
  kind: 'oauth' as const,
  instructions: [{ label: 'Or set a GitHub token env var on a headless remote', command: 'GH_TOKEN=…' }],
};
const COPILOT_AUTH_DISPLAY_NAME = 'Copilot';

/** What to connect the ACP client to + the child to reap (production spawns a
 *  `copilot --acp` process; tests inject an in-process mock AgentApp). */
export interface CopilotAgentTarget {
  target: Stream | AgentApp;
  child?: ChildProcess;
}

export interface CopilotDeps {
  /** Open the agent transport for `cwd`. `appId` selects the per-app
   *  `COPILOT_HOME` (config-home isolation). Default: spawn `copilot --acp`. */
  openAgent?: (cwd: string, appId?: string) => CopilotAgentTarget;
  /** Resolve the in-process Shelf MCP bridge (level 1). Default: the shared HTTP
   *  server. Return null to omit it (tests skip starting a real HTTP server). */
  getShelfMcp?: () => Promise<{ url: string } | null>;
}

function defaultOpenAgent(cwd: string, appId?: string): CopilotAgentTarget {
  const { command, args } = resolveCopilotCommand();
  // COPILOT_HOME (per-app config-home) is set at SPAWN — it's process env, so it
  // must be right from the start (auth + skills live under it). appId is known by
  // caps-time now (threaded into gatherCapabilities), so the first spawn already
  // has it.
  const spawned = spawnAgentStdio(command, args, { cwd, env: copilotEnv(appId) });
  return { target: spawned.stream, child: spawned.child };
}

/** Where `copilot --acp` scans for skills, for `appId`: `$COPILOT_HOME/skills`.
 *  The provider only DECLARES this; the agent-server projects the canonical tree
 *  here (provider-boundary principle — the backend does no fs). */
function copilotSkillTarget(appId: string | undefined): string | undefined {
  const home = copilotConfigHome(appId);
  return home ? path.join(home, 'skills') : undefined;
}

export function createCopilotBackend(deps: CopilotDeps = {}): ServerBackend {
  const openAgent = deps.openAgent ?? defaultOpenAgent;
  const getShelfMcp = deps.getShelfMcp ?? getSharedShelfMcp;

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
  // The appId the live CONNECTION (process) was spawned for. COPILOT_HOME is
  // fixed at spawn, so a change here forces a process respawn (not just a new
  // session). Normally set once from the caps-time spawn.
  let connAppId: string | undefined;
  // The active turn's send — the permission bridge rides this lane so requests
  // reach the renderer on the current turn's id.
  let activeExecutionSend: SendFn | null = null;
  // The outstanding ACP prompt is the cancellation acknowledgement boundary.
  // session/cancel itself is a notification; only this prompt resolving with
  // stopReason:'cancelled' confirms that Copilot stopped its model/tool work.
  let activePromptCompletion: Promise<StopReason> | null = null;
  let loginRunner: LoginRunner | null = null;
  const permissions = createPermissionBridge(() => activeExecutionSend);
  let sessionSend: SendFn | null = null;

  // Live session config cached from provider snapshots. Mode and permission
  // remain provider-native and are never seeded from Shelf permission prefs.
  let sessionModes: SessionModeState | undefined;
  let sessionConfigOptions: SessionConfigOption[] | undefined;
  let currentModel: string | undefined;
  let currentEffort: string | undefined;

  const onRequestPermission: PermissionHandler = (context) => permissions.onRequestPermission(context);

  function nativePermissionControl(): PermissionControlCapabilities {
    const mode = sessionModes ? {
      label: 'Mode',
      currentValue: sessionModes.currentModeId,
      options: sessionModes.availableModes.map((option) => ({
        value: option.id,
        displayName: option.name,
        ...(option.description ? { description: option.description } : {}),
      })),
    } : undefined;
    const advertised = sessionConfigOptions?.find((option) => option.id === COPILOT_PERMISSION_OPTION_ID);
    let permission: Extract<PermissionControlCapabilities, { strategy: 'native' }>['permission'];
    if (advertised?.type === 'select') {
      permission = {
        label: advertised.name,
        ...(advertised.description ? { description: advertised.description } : {}),
        currentValue: advertised.currentValue,
        options: advertised.options.flatMap((option) => (
          'options' in option
            ? option.options.map((nested) => ({
                value: nested.value,
                displayName: nested.name,
                ...(nested.description ? { description: nested.description } : {}),
              }))
            : [{
                value: option.value,
                displayName: option.name,
                ...(option.description ? { description: option.description } : {}),
              }]
        )),
      };
    } else if (advertised) {
      serverLog('error', 'copilot', `malformed ${COPILOT_PERMISSION_OPTION_ID} config: expected select (session=${session?.sessionId ?? '<none>'}, type=${advertised.type})`);
    }
    return {
      strategy: PERMISSION_CONTROL_STRATEGIES.NATIVE,
      ...(mode ? { mode } : {}),
      ...(permission ? { permission } : {}),
    };
  }

  /** Caps from the live session config + the active current* selections, ready to
   * spread into a `capabilities` wire message. Canonical permission modes stay
   * empty because Copilot publishes its two independent native controls. */
  function buildCapabilities(): ProviderCapabilities {
    const availableCommands = session ? driver.getAvailableCommands(session.sessionId) : undefined;
    const input = { modes: sessionModes, configOptions: sessionConfigOptions, availableCommands };
    const base = mapSessionCapabilities(input);
    return {
      ...base,
      permissionModes: [],
      permissionControl: nativePermissionControl(),
      ...(currentModel ? { currentModel } : {}),
      ...(currentEffort ? { currentEffort } : {}),
    };
  }

  function publishCapabilities(): void {
    (sessionSend ?? activeExecutionSend)?.({ type: 'capabilities', ...buildCapabilities() });
  }

  const driver = createSessionDriver({
    onStateChange(sessionId, change) {
      if (!session || session.sessionId !== sessionId) return;
      if (change.kind === 'mode') {
        if (!sessionModes) {
          serverLog('error', 'copilot', `mode update without advertised modes (session=${sessionId}, mode=${change.currentModeId})`);
          return;
        }
        sessionModes = { ...sessionModes, currentModeId: change.currentModeId };
      } else {
        sessionConfigOptions = change.configOptions;
        const current = currentSelections({ configOptions: sessionConfigOptions });
        currentModel = current.currentModel;
        currentEffort = current.currentEffort;
      }
      publishCapabilities();
    },
  });

  async function applyModel(model: string): Promise<void> {
    const configId = configOptionIdForCategory(sessionConfigOptions, MODEL_CATEGORY);
    if (conn && session && configId) await driver.setConfigOption(conn.agent, session, configId, model);
    else if (conn && session) serverLog('warn', 'copilot', `setModel: no model config option on session ${session.sessionId}`);
  }

  async function applyEffort(effort: string): Promise<void> {
    const configId = configOptionIdForCategory(sessionConfigOptions, EFFORT_CATEGORY);
    if (conn && session && configId) await driver.setConfigOption(conn.agent, session, configId, effort);
    else if (conn && session) serverLog('warn', 'copilot', `setEffort: no thought_level config option on session ${session.sessionId}`);
  }

  async function applyNativeMode(modeId: string): Promise<void> {
    if (!sessionModes?.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error(`Copilot did not advertise native mode "${modeId}"`);
    }
    if (conn && session) await driver.setMode(conn.agent, session, modeId);
  }

  async function applyNativePermission(value: string): Promise<void> {
    const option = sessionConfigOptions?.find((candidate) => candidate.id === COPILOT_PERMISSION_OPTION_ID);
    if (!option || option.type !== 'select') throw new Error(`Copilot did not advertise ${COPILOT_PERMISSION_OPTION_ID} as a select option`);
    if (conn && session) await driver.setConfigOption(conn.agent, session, option.id, value);
  }

  /** Apply a config-edit turn (picker / status-bar): imperative apply + updated
   *  capabilities + an ack divider. No-op guard skips a re-pick of the live value. */
  async function applyConfigEdit(key: ConfigEditKey, value: string, send: SendFn): Promise<void> {
    const controls = nativePermissionControl();
    const cur = key === CONFIG_EDIT_KEYS.MODEL
      ? currentModel
      : key === CONFIG_EDIT_KEYS.EFFORT
        ? currentEffort
        : key === CONFIG_EDIT_KEYS.NATIVE_MODE
          ? controls.strategy === 'native' ? controls.mode?.currentValue : undefined
          : key === CONFIG_EDIT_KEYS.NATIVE_PERMISSION
            ? controls.strategy === 'native' ? controls.permission?.currentValue : undefined
            : undefined;
    if (cur === value) return;
    try {
      if (key === CONFIG_EDIT_KEYS.MODEL) await applyModel(value);
      else if (key === CONFIG_EDIT_KEYS.EFFORT) await applyEffort(value);
      else if (key === CONFIG_EDIT_KEYS.NATIVE_MODE) await applyNativeMode(value);
      else if (key === CONFIG_EDIT_KEYS.NATIVE_PERMISSION) await applyNativePermission(value);
      else throw new Error(`Copilot native strategy does not accept config key "${key}"`);
      send({ type: 'message', msgId: `m-${randomUUID().slice(0, 8)}`, msgType: 'system', content: formatConfigAck(key, value) });
    } catch (err) {
      send({ type: 'message', msgId: `m-${randomUUID().slice(0, 8)}`, msgType: 'error', content: `Failed to set ${key}: ${(err as Error)?.message ?? String(err)}` });
    }
  }

  /** Spawn `copilot --acp` (with the per-app COPILOT_HOME) + open the ACP
   *  connection once; reused across turns. */
  function ensureConnection(cwd: string, appId: string | undefined): AcpConnection {
    if (conn) return conn;
    const opened = openAgent(cwd, appId);
    child = opened.child ?? null;
    connAppId = appId;
    conn = openAcpConnection(opened.target, {
      name: 'shelf-copilot',
      onRequestPermission,
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
  async function ensureSession(
    input: { cwd: string; appId?: string; resumeId?: string | null },
    send: SendFn | null,
  ): Promise<AcpSession> {
    // appId is stable per app instance; now carried on caps too, so it's known
    // before the first spawn. Resolve against the last-seen value.
    if (input.appId) lastAppId = input.appId;
    const appId = input.appId ?? lastAppId;

    // COPILOT_HOME is fixed at spawn. If the live connection was spawned for a
    // DIFFERENT appId (e.g. a legacy caps call that lacked appId), tear it down so
    // it respawns with the right config-home. Normally a no-op (appId rides caps).
    if (conn && connAppId !== appId) {
      serverLog('debug', 'copilot', `appId changed (${String(connAppId).slice(0, 8)} → ${String(appId).slice(0, 8)}) — respawning connection for COPILOT_HOME`);
      try { conn.close(); } catch { /* best-effort */ }
      conn = null; child = null; connAppId = undefined; session = null; sessionCwd = null;
    }

    // Reuse only if cwd AND the MCP/skills context (appId) are unchanged — else
    // recreate so app-level MCP servers + skills take effect at session/new.
    if (session && sessionCwd === input.cwd && sessionAppId === appId) return session;
    if (session) driver.forget(session.sessionId);

    // Skills are already projected to `$COPILOT_HOME/skills` by the agent-server
    // (it calls skillTarget + projectAppSkills before this) — the backend does no
    // fs. copilot --acp scans config-home for them (ACP has no per-session field).
    const c = ensureConnection(input.cwd, appId);
    // ACP requires the `initialize` handshake before any session op. copilot --acp
    // has tolerated its absence, but sending it is spec-correct and consistent with
    // codex-acp (which hard-rejects session/new otherwise). Overlaps the setup below.
    await c.initialized;
    const mcp = loadProjectedMcpServers(appId);
    // Fail-loud: a bad/incomplete MCP entry is logged, not silently dropped.
    for (const e of mcp.errors) serverLog('warn', 'copilot', `MCP config: ${e}`);
    // Level 1 (Shelf built-in bridge) + level 2 (user MCP) coexist as mcpServers
    // entries. The shelf bridge is an in-process HTTP MCP server (see shelf-mcp.ts).
    const shelf = await getShelfMcp();
    const opts = {
      cwd: input.cwd,
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
        sessionModes = session.resumeSessionResponse?.modes ?? undefined;
        sessionConfigOptions = session.resumeSessionResponse?.configOptions ?? undefined;
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
    // Capability discovery can create the first native session before an
    // execution exists. Publish through the session sink in that case so the
    // agent-server's context wrapper persists the pointer immediately.
    (send ?? sessionSend)?.({ type: 'context_patch', patch: { lastSdkSessionId: session.sessionId } });
    return session;
  }

  return {
    async query(input: QueryInput, send: SendFn): Promise<void> {
      activeExecutionSend = send;
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
        const promptCompletion = driver.drivePromptTurn(
          conn!.agent,
          s,
          input.prompt,
          send,
          input.images,
          input.attachments,
        );
        activePromptCompletion = promptCompletion;
        try {
          await promptCompletion;
        } finally {
          if (activePromptCompletion === promptCompletion) activePromptCompletion = null;
        }
      } catch (err) {
        send({ type: 'error', error: `copilot: ${(err as Error)?.message ?? String(err)}` });
      } finally {
        activeExecutionSend = null;
        send({ type: 'status', state: 'idle' });
      }
    },

    // Post-turn: refresh the account-level premium-request credit via the SDK,
    // cache-aside on the per-host cache (see credit.ts). copilot --acp doesn't emit
    // ACP usage_update (upstream #4233), so this is the only channel for it.
    refreshAccountStatus(cache, send, appId) {
      return refreshCopilotCredit(cache, send, appId);
    },

    async gatherCapabilities(
      cwd: string,
      _sessionId?: string,
      _customModels?: unknown,
      intent?: { model?: string; effort?: string; permissionMode?: string },
      _cache?: unknown,
      appId?: string,
      restoreContext?: import('../../context-store').PersistedContext,
    ): Promise<ProviderCapabilities> {
      // appId now rides caps → the CLI spawn below already gets the per-app
      // COPILOT_HOME (config-home isolation), and login (which follows caps) can
      // reuse it via lastAppId.
      if (appId) lastAppId = appId;
      // Model/effort retain their existing persisted intent. Native mode and
      // permission always initialize from provider truth.
      if (intent?.model) currentModel = intent.model;
      if (intent?.effort) currentEffort = intent.effort;
      try {
        const s = await ensureSession({ cwd, appId, resumeId: restoreContext?.lastSdkSessionId }, null);
        // `available_commands_update` arrives out-of-turn just AFTER session/new,
        // so it may not be captured yet. Briefly wait for it (bounded) so the
        // slash-command autocomplete isn't empty on the first caps fetch. Resolves
        // as soon as it lands (~a few ms); caps have no requestId to push later.
        for (let i = 0; i < 20 && !driver.getAvailableCommands(s.sessionId); i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        // Fill any current* the renderer didn't pin from the agent's live values.
        const cur = currentSelections({ modes: sessionModes, configOptions: sessionConfigOptions });
        currentModel ??= cur.currentModel;
        currentEffort ??= cur.currentEffort;
        return buildCapabilities();
      } catch (err: any) {
        // A fresh session most commonly fails when unauthenticated → surface the
        // auth pane rather than an empty capability set. authMethod drives the
        // AuthPane's Login button (oauth branch); without it the pane shows no way
        // to start login. FAIL-LOUD: log the real failure — this is a catch-all, so
        // without the message a non-auth failure (CLI hang/config) is silently
        // mislabeled as "needs login".
        serverLog('warn', 'copilot', `gatherCapabilities failed → reporting authRequired: ${err?.message ?? String(err)}`);
        return {
          models: [],
          permissionModes: [],
          permissionControl: { strategy: PERMISSION_CONTROL_STRATEGIES.NATIVE },
          effortLevels: [],
          slashCommands: [],
          authRequired: true,
          authMethod: COPILOT_AUTH_METHOD,
        };
      }
    },

    setModel(model: string): Promise<void> { return applyModel(model); },
    setEffort(effort: string): Promise<void> { return applyEffort(effort); },
    bindSessionSend(send: SendFn): void { sessionSend = send; },

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
        cliPath = resolveCopilotCommand().command;
      } catch (err) {
        send({ type: 'auth_login_done', provider: COPILOT_AUTH_DISPLAY_NAME, ok: false, error: (err as Error)?.message ?? String(err) });
        return;
      }
      // Log into the per-app COPILOT_HOME so credentials land in the same config-
      // home the `--acp` session reads. lastAppId is set by the preceding caps
      // call (auth pane only shows after gatherCapabilities returns authRequired).
      if (!lastAppId) serverLog('warn', 'copilot', 'startLogin: appId unknown — login will use the default COPILOT_HOME, not the per-app dir');
      loginRunner = startCopilotLogin({
        cliPath,
        env: copilotEnv(lastAppId),
        onPrompt: (p) => send({
          type: 'auth_login_prompt',
          provider: COPILOT_AUTH_DISPLAY_NAME,
          verificationUri: p.verificationUri,
          userCode: p.userCode,
          prefilledUri: prefillLoginUrl(p),
        }),
      });
      loginRunner.done.then((r) => send({
        type: 'auth_login_done',
        provider: COPILOT_AUTH_DISPLAY_NAME,
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
      // Cooperative cancel while session/prompt is live; after that response has
      // already settled, Copilot autopilot may still emit session work. There is
      // no remaining request whose stopReason can acknowledge cancellation, so
      // notify first and then tear down the ACP process to guarantee it stopped.
      permissions.cancelAll();
      const promptCompletion = activePromptCompletion;
      const liveConn = conn;
      const liveSession = session;
      const liveChild = child;
      if (!liveConn || !liveSession) throw new Error('copilot cancel failed: no active ACP session');
      if (!promptCompletion) {
        try {
          await liveConn.agent.notify(methods.agent.session.cancel, { sessionId: liveSession.sessionId });
        } catch (err) {
          serverLog('warn', 'copilot', `post-prompt session/cancel failed; forcing connection close: ${(err as Error)?.message ?? String(err)}`);
        } finally {
          driver.forget(liveSession.sessionId);
          try { liveConn.close(); } catch { /* best-effort before process kill */ }
          try { liveChild?.kill(); } catch { /* best-effort; connection is already closed */ }
          if (conn === liveConn) {
            conn = null;
            child = null;
            connAppId = undefined;
            session = null;
            sessionCwd = null;
          }
        }
        return;
      }
      await liveConn.agent.notify(methods.agent.session.cancel, { sessionId: liveSession.sessionId });
      const stopReason = await promptCompletion;
      if (stopReason !== 'cancelled') {
        throw new Error(`copilot cancel failed: expected cancelled, received ${stopReason}`);
      }
    },

    skillTarget(appId: string | undefined): string | undefined {
      return copilotSkillTarget(appId);
    },

    resetSession(): void {
      if (session) driver.forget(session.sessionId);
      session = null;
      sessionCwd = null;
    },

    /** Drop the live connection (process + session) so the next turn respawns and
     *  re-reads the per-app COPILOT_HOME credentials a device-login just wrote.
     *  copilot's CLI self-creates COPILOT_HOME, so no configHome hook is needed —
     *  only this respawn after login. Mirrors the appId-change respawn, minus the
     *  appId check. */
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
