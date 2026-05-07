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

let getWindow: (() => BrowserWindow | null) | null = null;

export function initAgentManager(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;

  ipcMain.handle(IPC.AGENT_INIT, async (_e, payload) => {
    const { tabId, cwd, connection, provider, sessionId, ...opts } = payload;
    return startSession(tabId, cwd, connection, provider, { ...opts, sessionId });
  });

  ipcMain.handle(IPC.AGENT_SEND, async (_e, payload) => {
    const { tabId, prompt, images } = payload;
    return sendMessage(tabId, prompt, images);
  });

  ipcMain.handle(IPC.AGENT_STOP, async (_e, payload) => {
    return stopSession(payload.tabId);
  });

  ipcMain.handle(IPC.AGENT_DESTROY, async (_e, payload) => {
    return destroySession(payload.tabId);
  });

  ipcMain.handle(IPC.AGENT_RESOLVE_PERMISSION, async (_e, payload) => {
    return resolvePermission(payload.tabId, payload.toolUseId, payload.allow);
  });

  ipcMain.handle(IPC.AGENT_SET_PREFS, async (_e, payload) => {
    const { tabId, model, effort, permissionMode: mode } = payload;
    const session = sessions.get(tabId);
    if (!session) return false;
    if (model) session.backend.setModel?.(model);
    if (effort) session.backend.setEffort?.(effort);
    if (mode) session.backend.setPermissionMode?.(mode);
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
    return session.backend.checkAuth();
  });

  ipcMain.handle(IPC.AGENT_SLASH_COMMAND, async (_e, payload) => {
    const session = sessions.get(payload.tabId);
    if (!session) return { type: 'error', message: 'Session not found' };
    if (!session.backend.handleSlashCommand) return { type: 'pass-through' };
    return session.backend.handleSlashCommand(payload.cmd, payload.args ?? '', session.cwd);
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
  const backend = createRemoteBackend(connection, undefined, provider, sessionId);

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

  if (backend.getCapabilities) {
    const settings = loadSettings();
    const customModels = settings.ok ? settings.value.providerModels?.[provider as keyof NonNullable<typeof settings.value.providerModels>] : undefined;
    backend.getCapabilities(cwd, customModels).then((caps) => {
      send(IPC.AGENT_CAPABILITIES, tabId, caps);
    }).catch((err) => {
      log.error('agent', `${tag} capabilities error: ${err.message}`);
    });
  }

  return true;
}

async function sendMessage(tabId: string, prompt: string, images?: string[]): Promise<boolean> {
  const session = sessions.get(tabId);
  if (!session) return false;

  const tag = `[agent:${tabId.slice(0, 8)}]`;
  log.info('agent', `${tag} send promptLen=${prompt.length}`);

  session.state = 'streaming';
  send(IPC.AGENT_STATUS, tabId, { state: 'streaming' });

  const canUseTool = async (toolUseId: string, toolName: string, input: Record<string, unknown>) => {
    send(IPC.AGENT_PERMISSION_REQUEST, tabId, { toolUseId, toolName, input });
    return new Promise<PermissionResult>((resolve) => {
      session.pendingPermissions.set(toolUseId, resolve);
    });
  };

  try {
    for await (const event of session.backend.query(prompt, session.cwd, {
      canUseTool,
      images,
    })) {
      dispatchEvent(tabId, event);
    }
  } catch (err: any) {
    log.error('agent', `${tag} query error: ${err.message}`);
    send(IPC.AGENT_MESSAGE, tabId, { type: 'error', content: err.message });
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
    case 'auth_required':
      send(IPC.AGENT_AUTH_REQUIRED, tabId, event.provider);
      break;
    case 'error':
      send(IPC.AGENT_MESSAGE, tabId, { type: 'error', content: event.error });
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

function resolvePermission(tabId: string, toolUseId: string, allow: boolean): boolean {
  const session = sessions.get(tabId);
  if (!session) return false;
  const resolve = session.pendingPermissions.get(toolUseId);
  if (!resolve) return false;
  session.pendingPermissions.delete(toolUseId);
  resolve(allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied by user' });
  return true;
}

export function getAgentState(tabId: string): AgentSessionState | null {
  return sessions.get(tabId)?.state ?? null;
}

export function isAgentTab(tabId: string): boolean {
  return sessions.has(tabId);
}

export function disposeAllAgents(): void {
  for (const session of sessions.values()) {
    session.backend.dispose();
  }
  sessions.clear();
}
