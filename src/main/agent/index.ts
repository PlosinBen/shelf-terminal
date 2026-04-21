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
import { createConnector } from '../connector';

const MAX_INLINE_BYTES = 100 * 1024; // 100KB per file

async function inlineFileAttachments(
  connection: Connection,
  cwd: string,
  paths: string[],
  prompt: string,
): Promise<string> {
  const connector = createConnector(connection);
  const parts: string[] = [];

  for (const p of paths) {
    try {
      // Size probe + read in one exec. wc -c prints the byte count; cat emits
      // up to 100KB; we post-process so oversized files fall back to a pointer.
      const { stdout: sizeOut } = await connector.exec(cwd, `wc -c < ${shellQuote(p)} 2>/dev/null || echo -1`);
      const size = parseInt(sizeOut.trim(), 10);
      if (!Number.isFinite(size) || size < 0) {
        parts.push(`[Attached: ${p} — could not read]`);
        continue;
      }
      if (size > MAX_INLINE_BYTES) {
        parts.push(`[Attached: ${p} (${(size / 1024).toFixed(1)} KB, too large to inline — use Read tool)]`);
        continue;
      }

      const { stdout } = await connector.exec(cwd, `cat ${shellQuote(p)}`);
      // Binary heuristic: null byte in first 8KB → binary, refer only.
      const head = stdout.slice(0, 8192);
      if (head.includes('\u0000')) {
        parts.push(`[Binary file attached: ${p} — use Read tool to inspect]`);
        continue;
      }
      parts.push(`=== ${p} ===\n${stdout.replace(/\n*$/, '')}\n=== end ===`);
    } catch (err: any) {
      parts.push(`[Attached: ${p} — read failed: ${err?.message ?? 'error'}]`);
    }
  }

  if (parts.length === 0) return prompt;
  return parts.join('\n\n') + (prompt ? `\n\n${prompt}` : '');
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

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
    return createRemoteBackend(connection, initScript, provider);
  }

  switch (provider) {
    case 'claude':
      return createClaudeBackend();
    case 'copilot':
      return createCopilotBackend(connection);
    case 'gemini':
      return createGeminiBackend(connection);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

interface AgentInitPrefs {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

/**
 * Compose a ProviderCapabilities blob from a backend by calling each of its
 * method-per-capability getters. Falls back to the legacy `warmup()` method
 * for backends that haven't migrated yet. Parallelises the async getters so
 * providers whose getters share state (Claude caches SDK init across calls)
 * still only pay the upfront cost once.
 */
async function gatherCapabilities(backend: AgentBackend, cwd: string): Promise<ProviderCapabilities | null> {
  // Remote backends aggregate on the server side in a single round-trip.
  if (backend.getCapabilities) return backend.getCapabilities(cwd);
  if (!backend.getModels || !backend.getSlashCommands) return null;
  const [models, slashCommands] = await Promise.all([
    backend.getModels(cwd),
    backend.getSlashCommands(),
  ]);
  return {
    models: models.map((m) => ({
      value: m.id,
      displayName: m.displayName,
      effortLevels: m.effortLevels,
      vision: m.vision,
    })),
    permissionModes: backend.getPermissionModes?.() ?? ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    effortLevels: backend.getEffortLevels?.() ?? [],
    slashCommands,
    authMethod: backend.getAuthMethod?.(),
  };
}

async function ensureSession(
  tabId: string,
  provider: AgentProvider,
  connection: Connection,
  cwd: string,
  initScript?: string,
  prefs?: AgentInitPrefs,
  sessionIds?: Partial<Record<AgentProvider, string>>,
): Promise<Session> {
  let session = sessions.get(tabId);
  if (session) return session;

  log.info('agent', `session.create tab=${tabId} provider=${provider} connection=${connection.type} cwd=${cwd} resume=${sessionIds?.[provider] ?? '-'}`);
  const backend = createBackend(provider, connection, initScript);
  // Seed providerSessionIds so (a) the first send()  passes `resume` to the
  // backend and (b) switching providers within the tab re-uses whichever
  // session id was previously captured for that provider. Empty/missing
  // entries just mean "start fresh" for that provider.
  const providerSessionIds: Partial<Record<AgentProvider, string>> = { ...(sessionIds ?? {}) };
  session = {
    tabId, projectId: '', provider, backend, state: 'idle',
    sdkSessionId: providerSessionIds[provider],
    permissionMode: prefs?.permissionMode ?? 'default',
    pendingPermissions: new Map(),
    providerSessionIds,
    sessionAllowlist: new Set(),
  };
  sessions.set(tabId, session);

  if (backend.checkAuth) {
    const ok = await backend.checkAuth();
    if (!ok) {
      log.info('agent', `session.auth_required tab=${tabId} provider=${provider}`);
      broadcast(IPC.AGENT_AUTH_REQUIRED, { tabId, provider });
      return session;
    }
  }

  // Apply persisted prefs BEFORE gathering capabilities so the payload echoes
  // the current state back to the UI in a single event.
  if (prefs?.model) backend.setModel?.(prefs.model);
  if (prefs?.effort) backend.setEffort?.(prefs.effort);

  let caps: ProviderCapabilities | null = null;
  try {
    caps = await gatherCapabilities(backend, cwd);
  } catch (err: any) {
    log.error('agent', `gatherCapabilities failed (${provider}): ${err?.message ?? err}`);
    broadcast(IPC.AGENT_MESSAGE, { tabId, type: 'error', content: err?.message ?? 'Failed to load capabilities' });
  }
  if (caps) {
    log.info('agent', `session.capabilities tab=${tabId} models=${caps.models.length} commands=${caps.slashCommands.length} model=${prefs?.model ?? caps.models[0]?.value ?? '-'} effort=${prefs?.effort ?? '-'} permMode=${session.permissionMode}`);
    broadcast(IPC.AGENT_CAPABILITIES, {
      tabId,
      ...caps,
      currentModel: prefs?.model ?? caps.models[0]?.value,
      currentEffort: prefs?.effort,
      currentPermissionMode: session.permissionMode,
    });
  }
  return session;
}

export function registerAgentHandlers() {
  ipcMain.handle(IPC.AGENT_INIT, async (_event, { tabId, provider, connection, cwd, initScript, prefs, sessionIds }: { tabId: string; provider: AgentProvider; connection: Connection; cwd: string; initScript?: string; prefs?: AgentInitPrefs; sessionIds?: Partial<Record<AgentProvider, string>> }) => {
    await ensureSession(tabId, provider, connection, cwd, initScript, prefs, sessionIds);
  });

  ipcMain.handle(IPC.AGENT_SEND, async (_event, { tabId, prompt, cwd, provider, connection, initScript, attachments }: { tabId: string; prompt: string; cwd: string; provider: AgentProvider; connection: Connection; initScript?: string; attachments?: { files?: string[]; images?: string[] } }) => {
    const session = await ensureSession(tabId, provider, connection, cwd, initScript);

    if (attachments?.files?.length) {
      prompt = await inlineFileAttachments(connection, cwd, attachments.files, prompt);
    }

    if (session.state === 'streaming') {
      log.debug('agent', `send.busy tab=${tabId} — ignoring (already streaming)`);
      return;
    }

    log.debug('agent', `send tab=${tabId} provider=${session.provider} promptLen=${prompt.length} files=${attachments?.files?.length ?? 0} images=${attachments?.images?.length ?? 0} resume=${session.sdkSessionId ?? '-'}`);
    session.state = 'streaming';
    broadcast(IPC.AGENT_STATUS, { tabId, state: 'streaming' });

    const canUseTool = async (toolUseId: string, toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
      const key = allowlistKey(toolName, input);
      if (session.sessionAllowlist.has(key)) {
        log.debug('agent', `permission.auto_allow tab=${tabId} tool=${toolName} key=${key}`);
        return { behavior: 'allow' };
      }
      log.debug('agent', `permission.request tab=${tabId} tool=${toolName} toolUseId=${toolUseId}`);
      broadcast(IPC.AGENT_PERMISSION_REQUEST, { tabId, toolUseId, toolName, input });

      return new Promise<PermissionResult>((resolve) => {
        session!.pendingPermissions.set(toolUseId, resolve);
      });
    };

    const turnStart = Date.now();
    const eventCounts: Record<string, number> = {};
    try {
      const generator = session.backend.query(prompt, cwd, {
        resume: session.sdkSessionId,
        permissionMode: session.permissionMode,
        canUseTool,
        images: attachments?.images,
      });

      for await (const event of generator) {
        eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
        switch (event.type) {
          case 'message':
            broadcast(IPC.AGENT_MESSAGE, { tabId, ...event.payload });
            if (event.payload.sessionId && !session.sdkSessionId) {
              session.sdkSessionId = event.payload.sessionId;
              session.providerSessionIds[session.provider] = event.payload.sessionId;
              log.info('agent', `session.sdk_id_captured tab=${tabId} provider=${session.provider} sessionId=${event.payload.sessionId}`);
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
            log.error('agent', `event.error tab=${tabId} provider=${session.provider}: ${event.error}`);
            broadcast(IPC.AGENT_MESSAGE, { tabId, type: 'error', content: event.error });
            break;
          case 'auth_required':
            log.info('agent', `event.auth_required tab=${tabId} provider=${event.provider}`);
            broadcast(IPC.AGENT_AUTH_REQUIRED, { tabId, provider: event.provider });
            break;
        }
      }
      log.debug('agent', `send.done tab=${tabId} duration=${Date.now() - turnStart}ms events=${JSON.stringify(eventCounts)}`);
    } catch (err: any) {
      log.error('agent', `send.throw tab=${tabId} provider=${session.provider} duration=${Date.now() - turnStart}ms: ${err?.message ?? err}`);
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
      log.info('agent', `session.stop tab=${tabId} provider=${session.provider}`);
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
      log.info('agent', `session.destroy tab=${tabId} provider=${session.provider}`);
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
      log.info('agent', `permission.allowlist_add tab=${tabId} key=${allowlistKey(toolName, input ?? {})}`);
    }

    log.debug('agent', `permission.resolve tab=${tabId} tool=${toolName ?? '-'} toolUseId=${toolUseId} scope=${scope}`);
    const resolve = session.pendingPermissions.get(toolUseId);
    if (resolve) {
      session.pendingPermissions.delete(toolUseId);
      resolve(scope === 'deny' ? { behavior: 'deny', message: 'Denied by user' } : { behavior: 'allow' });
    }
  });

  ipcMain.handle(IPC.AGENT_SET_PREFS, async (_event, { tabId, prefs }: { tabId: string; prefs: AgentInitPrefs }) => {
    const session = sessions.get(tabId);
    if (!session) return;
    const changes = [
      prefs.model !== undefined ? `model=${prefs.model}` : null,
      prefs.effort !== undefined ? `effort=${prefs.effort}` : null,
      prefs.permissionMode !== undefined ? `permMode=${prefs.permissionMode}` : null,
    ].filter(Boolean);
    if (changes.length > 0) log.info('agent', `session.prefs tab=${tabId} ${changes.join(' ')}`);
    if (prefs.model !== undefined) session.backend.setModel?.(prefs.model);
    if (prefs.effort !== undefined) session.backend.setEffort?.(prefs.effort);
    if (prefs.permissionMode !== undefined) session.permissionMode = prefs.permissionMode;
  });

  ipcMain.handle(IPC.AGENT_STORE_CREDENTIAL, async (_event, { tabId, key }: { tabId: string; key: string }) => {
    const session = sessions.get(tabId);
    if (!session) return { ok: false, error: 'Session not found' };
    if (!session.backend.storeCredential) {
      return { ok: false, error: 'This provider does not accept API keys' };
    }
    try {
      await session.backend.storeCredential(key);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Failed to store credential' };
    }
  });

  ipcMain.handle(IPC.AGENT_CHECK_AUTH, async (_event, { tabId }: { tabId: string }) => {
    const session = sessions.get(tabId);
    if (!session) return { authenticated: false };
    try {
      const authed = await session.backend.checkAuth();
      return { authenticated: authed };
    } catch {
      return { authenticated: false };
    }
  });

  ipcMain.handle(IPC.AGENT_CLEAR_CREDENTIAL, async (_event, { tabId }: { tabId: string }) => {
    const session = sessions.get(tabId);
    if (!session) return { ok: false, error: 'Session not found' };
    if (!session.backend.clearCredential) {
      return { ok: false, error: 'This provider has no credential to clear' };
    }
    try {
      await session.backend.clearCredential();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Failed to clear credential' };
    }
  });

  ipcMain.handle(IPC.AGENT_SWITCH_PROVIDER, async (_event, { tabId, provider, connection, initScript }: { tabId: string; provider: AgentProvider; connection: Connection; initScript?: string }) => {
    const session = sessions.get(tabId);
    if (!session) return;

    log.info('agent', `session.switch_provider tab=${tabId} ${session.provider} -> ${provider}`);
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
