import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { createClaudeBackend } from './providers/claude';
import { createCopilotBackend } from './providers/copilot';
import { createGeminiBackend } from './providers/gemini';
import { createRemoteBackend } from './remote';
import { log } from '@shared/logger';
import type { AgentProvider, Connection } from '@shared/types';
import type { AgentBackend, AgentSessionState, PermissionResult, ProviderCapabilities } from './types';
import { isAuthenticated } from './auth/copilot-auth';

interface Session {
  tabId: string;
  projectId: string;
  provider: AgentProvider;
  backend: AgentBackend;
  state: AgentSessionState;
  sdkSessionId?: string;
  permissionMode: string;
  pendingPermissions: Map<string, (result: PermissionResult) => void>;
  providerSessionIds: Partial<Record<AgentProvider, string>>;
  sessionAllowlist: Set<string>;
}

function allowlistKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash') {
    const cmd = String(input.command ?? '').trim();
    const firstWord = cmd.split(/\s+/)[0] ?? '';
    return `Bash:${firstWord}`;
  }
  return toolName;
}

const sessions = new Map<string, Session>();

function getWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows[0] ?? null;
}

function broadcast(channel: string, payload: unknown) {
  getWindow()?.webContents.send(channel, payload);
}

function createBackend(provider: AgentProvider, connection: Connection, initScript?: string): AgentBackend {
  const isRemote = connection.type !== 'local';

  if (isRemote) {
    return createRemoteBackend(connection, initScript);
  }

  switch (provider) {
    case 'claude':
      return createClaudeBackend();
    case 'copilot':
      return createCopilotBackend(connection);
    case 'gemini':
      return createGeminiBackend();
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

interface AgentInitPrefs {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

async function ensureSession(
  tabId: string,
  provider: AgentProvider,
  connection: Connection,
  cwd: string,
  initScript?: string,
  prefs?: AgentInitPrefs,
): Promise<Session> {
  let session = sessions.get(tabId);
  if (session) return session;

  const backend = createBackend(provider, connection, initScript);
  session = {
    tabId, projectId: '', provider, backend, state: 'idle',
    permissionMode: prefs?.permissionMode ?? 'default',
    pendingPermissions: new Map(),
    providerSessionIds: {},
    sessionAllowlist: new Set(),
  };
  sessions.set(tabId, session);

  if (backend.checkAuth) {
    const ok = await backend.checkAuth();
    if (!ok) {
      broadcast(IPC.AGENT_AUTH_REQUIRED, { tabId, provider });
      return session;
    }
  }

  // Apply persisted prefs BEFORE warmup so the capability payload can echo
  // the current state back to the UI in a single event.
  if (prefs?.model) backend.setModel?.(prefs.model);
  if (prefs?.effort) backend.setEffort?.(prefs.effort);

  if (backend.warmup) {
    const caps = await backend.warmup(cwd);
    if (caps) {
      broadcast(IPC.AGENT_CAPABILITIES, {
        tabId,
        ...caps,
        currentModel: prefs?.model ?? caps.currentModel ?? caps.models[0]?.value,
        currentEffort: prefs?.effort ?? caps.currentEffort,
        currentPermissionMode: session.permissionMode,
      });
    }
  }
  return session;
}

export function registerAgentHandlers() {
  ipcMain.handle(IPC.AGENT_INIT, async (_event, { tabId, provider, connection, cwd, initScript, prefs }: { tabId: string; provider: AgentProvider; connection: Connection; cwd: string; initScript?: string; prefs?: AgentInitPrefs }) => {
    await ensureSession(tabId, provider, connection, cwd, initScript, prefs);
  });

  ipcMain.handle(IPC.AGENT_SEND, async (_event, { tabId, prompt, cwd, provider, connection, initScript }: { tabId: string; prompt: string; cwd: string; provider: AgentProvider; connection: Connection; initScript?: string }) => {
    const session = await ensureSession(tabId, provider, connection, cwd, initScript);

    if (session.state === 'streaming') {
      return;
    }

    session.state = 'streaming';
    broadcast(IPC.AGENT_STATUS, { tabId, state: 'streaming' });

    const canUseTool = async (toolUseId: string, toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
      const key = allowlistKey(toolName, input);
      if (session.sessionAllowlist.has(key)) {
        return { behavior: 'allow' };
      }
      broadcast(IPC.AGENT_PERMISSION_REQUEST, { tabId, toolUseId, toolName, input });

      return new Promise<PermissionResult>((resolve) => {
        session!.pendingPermissions.set(toolUseId, resolve);
      });
    };

    try {
      const generator = session.backend.query(prompt, cwd, {
        resume: session.sdkSessionId,
        permissionMode: session.permissionMode,
        canUseTool,
      });

      for await (const event of generator) {
        switch (event.type) {
          case 'message':
            broadcast(IPC.AGENT_MESSAGE, { tabId, ...event.payload });
            if (event.payload.sessionId && !session.sdkSessionId) {
              session.sdkSessionId = event.payload.sessionId;
              session.providerSessionIds[session.provider] = event.payload.sessionId;
            }
            break;
          case 'stream':
            broadcast(IPC.AGENT_STREAM, { tabId, ...event.payload });
            break;
          case 'status':
            session.state = event.payload.state;
            broadcast(IPC.AGENT_STATUS, { tabId, ...event.payload });
            break;
          case 'error':
            broadcast(IPC.AGENT_MESSAGE, { tabId, type: 'error', content: event.error });
            break;
          case 'auth_required':
            broadcast(IPC.AGENT_AUTH_REQUIRED, { tabId, provider: event.provider });
            break;
        }
      }
    } catch (err: any) {
      broadcast(IPC.AGENT_MESSAGE, { tabId, type: 'error', content: err.message ?? 'Unknown error' });
    } finally {
      for (const resolve of session.pendingPermissions.values()) {
        resolve({ behavior: 'deny', message: 'Session ended' });
      }
      session.pendingPermissions.clear();
      session.state = 'idle';
      broadcast(IPC.AGENT_STATUS, { tabId, state: 'idle' });
    }
  });

  ipcMain.handle(IPC.AGENT_STOP, async (_event, { tabId }: { tabId: string }) => {
    const session = sessions.get(tabId);
    if (session) {
      for (const resolve of session.pendingPermissions.values()) {
        resolve({ behavior: 'deny', message: 'Stopped by user' });
      }
      session.pendingPermissions.clear();
      await session.backend.stop();
    }
  });

  ipcMain.handle(IPC.AGENT_DESTROY, async (_event, { tabId }: { tabId: string }) => {
    const session = sessions.get(tabId);
    if (session) {
      for (const resolve of session.pendingPermissions.values()) {
        resolve({ behavior: 'deny', message: 'Session destroyed' });
      }
      session.backend.dispose();
      sessions.delete(tabId);
    }
  });

  ipcMain.handle(IPC.AGENT_RESOLVE_PERMISSION, async (_event, { tabId, toolUseId, scope, toolName, input }: { tabId: string; toolUseId: string; scope: 'once' | 'session' | 'deny'; toolName?: string; input?: Record<string, unknown> }) => {
    const session = sessions.get(tabId);
    if (!session) return;

    if (scope === 'session' && toolName) {
      session.sessionAllowlist.add(allowlistKey(toolName, input ?? {}));
    }

    const resolve = session.pendingPermissions.get(toolUseId);
    if (resolve) {
      session.pendingPermissions.delete(toolUseId);
      resolve(scope === 'deny' ? { behavior: 'deny', message: 'Denied by user' } : { behavior: 'allow' });
    }
  });

  ipcMain.handle(IPC.AGENT_SET_PREFS, async (_event, { tabId, prefs }: { tabId: string; prefs: AgentInitPrefs }) => {
    const session = sessions.get(tabId);
    if (!session) return;
    if (prefs.model !== undefined) session.backend.setModel?.(prefs.model);
    if (prefs.effort !== undefined) session.backend.setEffort?.(prefs.effort);
    if (prefs.permissionMode !== undefined) session.permissionMode = prefs.permissionMode;
  });

  ipcMain.handle(IPC.AGENT_SWITCH_PROVIDER, async (_event, { tabId, provider, connection, initScript }: { tabId: string; provider: AgentProvider; connection: Connection; initScript?: string }) => {
    const session = sessions.get(tabId);
    if (!session) return;

    session.providerSessionIds[session.provider] = session.sdkSessionId;

    session.backend.dispose();

    session.provider = provider;
    session.backend = createBackend(provider, connection, initScript);
    session.state = 'idle';
    session.sdkSessionId = session.providerSessionIds[provider];

    broadcast(IPC.AGENT_STATUS, { tabId, state: 'idle', model: undefined });
  });

  ipcMain.handle(IPC.COPILOT_AUTH_RECHECK, async () => {
    return { authenticated: await isAuthenticated() };
  });
  log.info('agent', 'Agent IPC handlers registered');
}

export function destroyAllSessions() {
  for (const session of sessions.values()) {
    for (const resolve of session.pendingPermissions.values()) {
      resolve({ behavior: 'deny', message: 'App shutting down' });
    }
    session.backend.dispose();
  }
  sessions.clear();
}
