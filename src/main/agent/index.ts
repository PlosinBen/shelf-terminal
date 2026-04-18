import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { createClaudeBackend } from './providers/claude';
import { createRemoteBackend } from './remote';
import { log } from '@shared/logger';
import type { AgentProvider, Connection } from '@shared/types';
import type { AgentBackend, AgentSessionState, PermissionResult } from './types';

interface Session {
  tabId: string;
  projectId: string;
  provider: AgentProvider;
  backend: AgentBackend;
  state: AgentSessionState;
  sdkSessionId?: string;
  permissionMode: string;
  pendingPermissions: Map<string, (result: PermissionResult) => void>;
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
    case 'gemini':
      throw new Error(`Provider '${provider}' not yet implemented`);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export function registerAgentHandlers() {
  ipcMain.handle(IPC.AGENT_SEND, async (_event, { tabId, prompt, cwd, provider, connection, initScript }: { tabId: string; prompt: string; cwd: string; provider: AgentProvider; connection: Connection; initScript?: string }) => {
    let session = sessions.get(tabId);

    if (!session) {
      const backend = createBackend(provider, connection, initScript);
      session = {
        tabId, projectId: '', provider, backend, state: 'idle',
        permissionMode: 'default',
        pendingPermissions: new Map(),
      };
      sessions.set(tabId, session);
    }

    if (session.state === 'streaming') {
      return;
    }

    session.state = 'streaming';
    broadcast(IPC.AGENT_STATUS, { tabId, state: 'streaming' });

    const canUseTool = async (toolUseId: string, toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
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
            session.state = 'error';
            broadcast(IPC.AGENT_ERROR, { tabId, error: event.error });
            break;
        }
      }
    } catch (err: any) {
      session.state = 'error';
      broadcast(IPC.AGENT_ERROR, { tabId, error: err.message ?? 'Unknown error' });
    }

    // Reject any pending permissions
    for (const resolve of session.pendingPermissions.values()) {
      resolve({ behavior: 'deny', message: 'Session ended' });
    }
    session.pendingPermissions.clear();

    if (session.state === 'streaming') {
      session.state = 'idle';
      broadcast(IPC.AGENT_STATUS, { tabId, state: 'idle' });
    }
  });

  ipcMain.handle(IPC.AGENT_STOP, async (_event, { tabId }: { tabId: string }) => {
    const session = sessions.get(tabId);
    if (session) {
      await session.backend.stop();
      session.state = 'idle';
      broadcast(IPC.AGENT_STATUS, { tabId, state: 'idle' });
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

  ipcMain.handle(IPC.AGENT_RESOLVE_PERMISSION, async (_event, { tabId, toolUseId, allow }: { tabId: string; toolUseId: string; allow: boolean }) => {
    const session = sessions.get(tabId);
    if (!session) return;

    const resolve = session.pendingPermissions.get(toolUseId);
    if (resolve) {
      session.pendingPermissions.delete(toolUseId);
      resolve(allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied by user' });
    }
  });

  ipcMain.handle(IPC.AGENT_SET_MODE, async (_event, { tabId, mode }: { tabId: string; mode: string }) => {
    const session = sessions.get(tabId);
    if (session) {
      session.permissionMode = mode;
    }
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
