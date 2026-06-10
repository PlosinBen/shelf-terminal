import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { log } from '@shared/logger';
import type { Connection, AgentProvider } from '@shared/types';
import type { AgentSessionState, AgentEvent, AgentBackend, PermissionResult } from './types';
import { createRemoteBackend } from './remote';
import { loadSettings } from '../settings-store';

interface SessionInstance {
  tabId: string;
  provider: AgentProvider;
  connection: Connection;
  cwd: string;
  backend: AgentBackend;
  state: AgentSessionState;
  pendingPermissions: Map<string, (result: PermissionResult) => void>;
}

const sessions = new Map<string, SessionInstance>();

// ── Internal output observers (for Telegram bridge etc.) ──
// Lets in-process modules (PM telegram bridge) tee EVERY tab's outgoing agent
// events without going through renderer IPC. Observers are global — there is
// no per-tab subscription; the bridge listens to everything and filters by
// `(mode active && tabId matches)` inside its own handler.
//
// Rationale: dispatchEvent is a pure transport layer. It MUST NOT know which
// consumers care about which tabs, or which buffering / display strategy each
// consumer uses (renderer streams chunk-by-chunk, telegram batches + flushes
// on idle). Pushing tabId filtering and lifecycle into the consumer keeps
// dispatch O(1) and lets the bridge be a permanent listener registered once
// at app boot — no register/unregister coupled to mode switches.
//
// See DECISIONS-pm #67 (Architecture: Global Observer).
type GlobalObserver = (tabId: string, event: AgentEvent) => void;
const globalObservers = new Set<GlobalObserver>();

function notifyObservers(tabId: string, event: AgentEvent): void {
  if (globalObservers.size === 0) return;
  // Snapshot in case an observer unsubscribes during iteration.
  for (const obs of Array.from(globalObservers)) {
    try {
      obs(tabId, event);
    } catch (e: any) {
      log.error('agent', `observer error tab=${tabId.slice(0, 8)}: ${e?.message ?? e}`);
    }
  }
}

let getWindow: (() => BrowserWindow | null) | null = null;

export function initAgentManager(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;

  ipcMain.handle(IPC.AGENT_INIT, async (_e, payload) => {
    const { tabId, cwd, connection, provider, sessionId, ...opts } = payload;
    return startSession(tabId, cwd, connection, provider, { ...opts, sessionId });
  });

  ipcMain.handle(IPC.AGENT_SEND, async (_e, payload) => {
    const { tabId, prompt, images, model, effort, permissionMode, configEdit } = payload;
    return sendMessage(tabId, prompt, images, { model, effort, permissionMode, configEdit });
  });

  ipcMain.handle(IPC.AGENT_STOP, async (_e, payload) => {
    return stopSession(payload.tabId);
  });

  ipcMain.handle(IPC.AGENT_DESTROY, async (_e, payload) => {
    return destroySession(payload.tabId);
  });

  ipcMain.handle(IPC.AGENT_RESOLVE_PERMISSION, async (_e, payload) => {
    return resolvePermission(payload.tabId, payload.toolUseId, payload.allow, payload.scope);
  });

  ipcMain.handle(IPC.AGENT_RESOLVE_PICKER, async (_e, payload) => {
    const session = sessions.get(payload.tabId);
    if (!session?.backend.resolvePicker) return false;
    // Payload comes from renderer pre-shaped as PickerResolvePayload; preload
    // is a thin pass-through (see src/main/preload.ts resolvePicker).
    session.backend.resolvePicker(payload.pickerId, payload.payload);
    return true;
  });

  ipcMain.handle(IPC.AGENT_STORE_CREDENTIAL, async (_e, payload) => {
    const session = sessions.get(payload.tabId);
    if (!session?.backend.storeCredential) return false;
    await session.backend.storeCredential(payload.key);
    return true;
  });

  ipcMain.handle(IPC.AGENT_CLEAR_CREDENTIAL, async (_e, payload) => {
    const session = sessions.get(payload.tabId);
    if (!session?.backend.clearCredential) return false;
    await session.backend.clearCredential();
    return true;
  });

  ipcMain.handle(IPC.AGENT_CHECK_AUTH, async (_e, payload) => {
    const session = sessions.get(payload.tabId);
    if (!session) return false;
    return session.backend.checkAuth(session.cwd);
  });

  ipcMain.handle(IPC.AGENT_READ_TASK_OUTPUT, async (_e, payload) => {
    const session = sessions.get(payload.tabId);
    if (!session?.backend.readTaskOutput) throw new Error('No session for task output');
    return session.backend.readTaskOutput(payload.taskId);
  });

}

function send(channel: string, tabId: string, ...args: unknown[]) {
  const win = getWindow?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, tabId, ...args);
  }
}

async function startSession(
  tabId: string,
  cwd: string,
  connection: Connection,
  provider: AgentProvider,
  opts?: Record<string, unknown>,
): Promise<boolean> {
  if (sessions.has(tabId)) return true;

  const tag = `[agent:${tabId.slice(0, 8)}]`;
  log.info('agent', `${tag} start provider=${provider} cwd=${cwd}`);

  const sessionId = opts?.sessionId as string | undefined;
  const backend = createRemoteBackend(
    connection,
    undefined,
    provider,
    sessionId,
    // Refine the renderer's "starting" spinner text as deploy/spawn/probe
    // progress (deploying → connecting → checking-auth).
    (phase) => send(IPC.AGENT_INIT_STATUS, tabId, { state: 'starting', phase }),
    // Background-task sink — forwarded straight to the renderer. Session-level
    // (NOT tied to session.state): a backgrounded task outlives its turn, so we
    // never touch the turn's busy/idle state here. See DECISIONS #69.
    (ev) => send(IPC.AGENT_BACKGROUND_TASKS, tabId, ev),
    // Server-initiated turn (auto-resume prose after a background task). Drain
    // the turn's events into the renderer like a normal turn, but SKIP its
    // status events: the tab's busy/idle spinner belongs to the user's
    // foreground turn, and forwarding this turn's idle would clear the spinner
    // of an unrelated in-flight foreground turn. The dispatcher still ends the
    // generator on idle independently. See DECISIONS #69.
    (turnId, events) => {
      void (async () => {
        try {
          for await (const ev of events) {
            if (ev.type === 'status') continue;
            dispatchEvent(tabId, ev);
          }
        } catch (err: any) {
          log.error('agent', `${tag} server-turn ${turnId} drain error: ${err?.message ?? err}`);
        }
      })();
    },
    // Connection health from the heartbeat round-trip (per-tab agent-server).
    // The renderer aggregates per-project (worst among the project's agent
    // tabs) for the project status icon. See §5.9.
    (healthState) => send(IPC.AGENT_CONNECTION_HEALTH, tabId, healthState),
  );

  const session: SessionInstance = {
    tabId,
    provider,
    connection,
    cwd,
    backend,
    state: 'idle',
    pendingPermissions: new Map(),
  };

  sessions.set(tabId, session);

  // Init lifecycle hint for the renderer's loading spinner / retry UI.
  send(IPC.AGENT_INIT_STATUS, tabId, { state: 'starting' });

  if (backend.getCapabilities) {
    const settings = loadSettings();
    const customModels = settings.ok ? settings.value.providerModels?.[provider as keyof NonNullable<typeof settings.value.providerModels>] : undefined;
    // `intent` originates in AgentView (projectConfig.agentPrefs[provider]),
    // carried through agent:init's opts → preload spread into AGENT_INIT
    // payload. Seeds the provider's session-level closures before the first
    // capabilities event so renderer's status bar reflects saved prefs after
    // reconnect instead of the provider's hardcoded default ("ask" etc.).
    const intent = (opts as { intent?: { model?: string; effort?: string; permissionMode?: string } } | undefined)?.intent;
    backend.getCapabilities(cwd, customModels, intent).then((caps) => {
      // Capabilities first so AuthPane can read caps.authMethod for its
      // instructions; then flip auth (reusing the existing auth_required
      // routing → setAuthRequired → AuthPane takeover); then mark ready (the
      // chat underneath is harmless while AuthPane covers the pane).
      send(IPC.AGENT_CAPABILITIES, tabId, caps);
      if (caps.authRequired) send(IPC.AGENT_AUTH_REQUIRED, tabId, provider);
      send(IPC.AGENT_INIT_STATUS, tabId, { state: 'ready' });
    }).catch((err) => {
      log.error('agent', `${tag} capabilities error: ${err.message}`);
      log.flushTrace('agent', `${tag} init failed`);
      send(IPC.AGENT_INIT_STATUS, tabId, { state: 'failed', reason: err.message });
    });
  } else {
    // Backend that exposes no capabilities is still "ready" — nothing to wait for.
    send(IPC.AGENT_INIT_STATUS, tabId, { state: 'ready' });
  }

  return true;
}

async function sendMessage(
  tabId: string,
  prompt: string,
  images?: string[],
  prefs?: {
    model?: string;
    effort?: string;
    permissionMode?: string;
    configEdit?: { key: 'model' | 'effort' | 'permissionMode'; value: string };
  },
): Promise<boolean> {
  const session = sessions.get(tabId);
  if (!session) return false;

  const tag = `[agent:${tabId.slice(0, 8)}]`;
  log.info('agent', `${tag} send promptLen=${(prompt ?? '').length}${prefs?.configEdit ? ` configEdit=${prefs.configEdit.key}` : ''}`);

  session.state = 'streaming';
  send(IPC.AGENT_STATUS, tabId, { state: 'streaming' });
  notifyObservers(tabId, { type: 'status', payload: { state: 'streaming' } });

  const canUseTool = async (toolUseId: string, toolName: string, input: Record<string, unknown>) => {
    send(IPC.AGENT_PERMISSION_REQUEST, tabId, { toolUseId, toolName, input });
    notifyObservers(tabId, { type: 'permission_request', toolUseId, toolName, input });
    return new Promise<PermissionResult>((resolve) => {
      session.pendingPermissions.set(toolUseId, resolve);
    });
  };

  try {
    for await (const event of session.backend.query(prompt, session.cwd, {
      canUseTool,
      images,
      model: prefs?.model,
      effort: prefs?.effort,
      permissionMode: prefs?.permissionMode,
      configEdit: prefs?.configEdit,
    })) {
      dispatchEvent(tabId, event);
    }
  } catch (err: any) {
    log.error('agent', `${tag} query error: ${err.message}`);
    send(IPC.AGENT_MESSAGE, tabId, { type: 'error', content: err.message });
    notifyObservers(tabId, { type: 'error', error: err.message });
  } finally {
    session.state = 'idle';
    for (const resolve of session.pendingPermissions.values()) {
      resolve({ behavior: 'deny', message: 'Turn ended' });
    }
    session.pendingPermissions.clear();
  }

  return true;
}

function dispatchEvent(tabId: string, event: AgentEvent) {
  // Tee everything backend.query yields to internal observers (e.g. Telegram
  // bridge mirror agent output). Observer fires before IPC dispatch so a
  // crash in observer won't block renderer updates.
  notifyObservers(tabId, event);
  switch (event.type) {
    case 'message':
      send(IPC.AGENT_MESSAGE, tabId, event.payload);
      break;
    case 'stream':
      send(IPC.AGENT_STREAM, tabId, event.payload);
      break;
    case 'status':
      send(IPC.AGENT_STATUS, tabId, event.payload);
      break;
    case 'plan':
      send(IPC.AGENT_PLAN, tabId, { content: event.content });
      break;
    case 'capabilities':
      // Mid-turn capabilities update (model/effort/permission changed during a
      // turn). Same IPC channel as the initial capabilities so the renderer's
      // onCapabilities → setCapabilities path updates the status bar.
      send(IPC.AGENT_CAPABILITIES, tabId, event.caps);
      break;
    case 'picker_request':
      send(IPC.AGENT_PICKER_REQUEST, tabId, {
        id: event.id,
        prompts: event.prompts,
      });
      break;
    case 'auth_required':
      send(IPC.AGENT_AUTH_REQUIRED, tabId, event.provider);
      break;
    case 'error':
      send(IPC.AGENT_MESSAGE, tabId, { type: 'error', content: event.error });
      break;
    case 'permission_request':
      // Handled via canUseTool callback in sendMessage — never reaches the
      // dispatcher event queue. Exhaustiveness only.
      break;
  }
}

async function stopSession(tabId: string): Promise<boolean> {
  const session = sessions.get(tabId);
  if (!session) return false;
  await session.backend.stop();
  session.state = 'idle';
  return true;
}

async function destroySession(tabId: string): Promise<boolean> {
  const session = sessions.get(tabId);
  if (!session) return false;
  session.backend.dispose();
  sessions.delete(tabId);
  return true;
}

function resolvePermission(tabId: string, toolUseId: string, allow: boolean, scope?: 'once' | 'session'): boolean {
  const session = sessions.get(tabId);
  if (!session) return false;
  const resolve = session.pendingPermissions.get(toolUseId);
  if (!resolve) return false;
  session.pendingPermissions.delete(toolUseId);
  resolve(allow ? { behavior: 'allow', scope } : { behavior: 'deny', message: 'Denied by user' });
  return true;
}

export function getAgentState(tabId: string): AgentSessionState | null {
  return sessions.get(tabId)?.state ?? null;
}

export function isAgentTab(tabId: string): boolean {
  return sessions.has(tabId);
}

/**
 * In-process equivalent of the AGENT_SEND IPC handler. Routes a prompt to an
 * existing agent session without going through renderer. Used by the Telegram
 * bridge in agent mode (see DECISIONS-pm #67).
 *
 * Returns the same boolean as sendMessage: false if tabId has no session, true
 * once the turn completes (including catch'd errors — those propagate through
 * the observer stream as AgentEvent.error, not as a rejected promise).
 *
 * Mirrors a user-message bubble into the renderer's history before kicking
 * off the turn. The IPC path doesn't need this because InputZone upserts the
 * user bubble locally before emitting agent:send — but internal callers (the
 * Telegram bridge) bypass that, so without this mirror the renderer would
 * only see the agent reply with no record of what was asked. The bridge IS
 * just a forwarder, so the agent view should look identical to a direct send.
 */
export async function sendFromInternal(
  tabId: string,
  prompt: string,
  displayText: string = prompt,
): Promise<boolean> {
  if (!sessions.has(tabId)) return false;
  // The Shelf user bubble mirrors `displayText` (the human-typed text); the
  // agent receives `prompt`, which the telegram bridge augments with a hidden
  // brevity hint. Keeping them separate stops the hint from leaking into the
  // visible conversation.
  send(IPC.AGENT_MESSAGE, tabId, {
    type: 'user',
    msgId: `bridge-user-${Date.now()}`,
    content: displayText,
  });
  return sendMessage(tabId, prompt);
}

/** In-process equivalent of the AGENT_STOP IPC handler. */
export async function stopFromInternal(tabId: string): Promise<boolean> {
  return stopSession(tabId);
}

/**
 * Subscribe to ALL tabs' agent output events. Mirrors every AgentEvent
 * flowing through dispatchEvent + the direct sends in sendMessage (status
 * streaming, permission_request, error). Observer receives `(tabId, event)`
 * and is responsible for filtering to the tabs it cares about.
 *
 * Returns an unsubscribe function — typically unused in practice since the
 * single consumer (telegram bridge) registers once at boot and lives the
 * whole process. Observer exceptions are logged and swallowed so a bridge
 * crash can't break the agent event stream feeding the renderer.
 */
export function registerOutputObserver(observer: GlobalObserver): () => void {
  globalObservers.add(observer);
  return () => {
    globalObservers.delete(observer);
  };
}

/**
 * Snapshot which tabs currently have agent sessions. Used by telegram bridge
 * /projects listing to know which projects have an agent open.
 */
export function listAgentTabs(): string[] {
  return Array.from(sessions.keys());
}

/**
 * Get provider type for an agent tab. Used by telegram bridge to display
 * "shelf_terminal/claude" style mode confirmation.
 */
export function getAgentProvider(tabId: string): AgentProvider | null {
  return sessions.get(tabId)?.provider ?? null;
}

export function disposeAllAgents(): void {
  for (const session of sessions.values()) {
    session.backend.dispose();
  }
  sessions.clear();
}
