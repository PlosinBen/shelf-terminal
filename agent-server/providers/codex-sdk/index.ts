import { CODEX_OFFICAL_PROVIDER } from '@shared/agent-providers';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ProviderModel } from '@shared/types';
import { parseSlashPrefix } from '@shared/slash-prefix';
import { codexConfigHome, codexEnv, resolveCodexCliCommand } from '../codex-shared/runtime';
import { driveDeviceCodeLogin, spawnCodexAppServerRpc, type LoginHandle, type LoginRpc } from '../codex-shared/app-server-login';
import { pickEffortLevels, pickPermissionModes, type ProviderCapabilities, type SendFn, type ServerBackend } from '../types';
import { formatConfigAck, type ConfigEditKey } from '@shared/config-ack';
import { CODEX_SDK_EFFORT_LEVELS, buildCodexSdkRuntimeConfig } from './config';
import { refreshCodexAccountStatus } from './account-status';
import { spawnCodexAppServerClient, type CodexAppServerNotificationHandler } from './app-server-client';
import { summarizeTokenUsageForLog, translateCodexAppServerNotification } from './app-server-translate';
import { loadProjectedMcpServers, type ParsedMcpConfig } from '../mcp-config';
import { getSharedShelfMcp } from '../acp/shelf-mcp';
import { serverLog } from '../../server-logger';

interface CodexAppServerLike {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  onNotification(method: string, handler: CodexAppServerNotificationHandler): void;
  close(): void;
}

const CODEX_SDK_SLASH_COMMANDS = [
  { name: 'mcp', description: 'List loaded MCP servers' },
  { name: 'skills', description: 'List loaded skills' },
  { name: 'skill', description: 'List loaded skills' },
  { name: 'clear', description: 'Clear Codex session context' },
  { name: 'compact', description: 'Compact context (not supported by Codex SDK yet)' },
] as const;

export interface CodexOfficialDeps {
  spawnLoginRpc?: (env: NodeJS.ProcessEnv) => { rpc: LoginRpc };
  createAppServer?: (env: NodeJS.ProcessEnv) => CodexAppServerLike;
  getShelfMcp?: () => Promise<{ url: string } | null>;
  loadMcpServers?: (appId: string | undefined, env?: Record<string, string | undefined>) => ParsedMcpConfig;
  listBundledModels?: () => ProviderCapabilities['models'];
  refreshAccountStatus?: (
    cache: Parameters<NonNullable<ServerBackend['refreshAccountStatus']>>[0],
    send: SendFn,
    appId?: string,
  ) => Promise<void>;
}

export function codexSdkHome(appId: string | undefined): string | undefined {
  const home = codexConfigHome(appId);
  return home ? path.join(path.dirname(home), 'codex-sdk-home') : undefined;
}

export function codexSdkSkillTarget(appId: string | undefined): string | undefined {
  const home = codexSdkHome(appId);
  return home ? path.join(home, '.agents', 'skills') : undefined;
}

export function createCodexOfficialBackend(deps: CodexOfficialDeps = {}): ServerBackend {
  let currentModel: string | undefined;
  let currentEffort: string | undefined;
  let currentPermissionMode: string | undefined;
  let lastAppId: string | undefined;
  let loginHandle: LoginHandle | null = null;
  let activeRun: symbol | null = null;
  let appServer: CodexAppServerLike | null = null;
  let appServerAppId: string | undefined;
  let appServerInitialized = false;
  let activeSend: SendFn | null = null;
  let activeThreadId: string | null = null;
  let activeTurnId: string | null = null;
  let resolveActiveTurn: (() => void) | null = null;
  const spawnLoginRpc = deps.spawnLoginRpc ?? ((env: NodeJS.ProcessEnv) => spawnCodexAppServerRpc(env));
  const createAppServer = deps.createAppServer ?? ((env: NodeJS.ProcessEnv) => spawnCodexAppServerClient(env).client);
  const getShelfMcp = deps.getShelfMcp ?? getSharedShelfMcp;
  const loadMcpServers = deps.loadMcpServers ?? loadProjectedMcpServers;
  const listBundledModels = deps.listBundledModels ?? listCodexBundledModels;
  const refreshAccount = deps.refreshAccountStatus ?? refreshCodexAccountStatus;

  async function ensureAppServer(appId: string | undefined, env: NodeJS.ProcessEnv): Promise<CodexAppServerLike> {
    if (appServer && appServerAppId !== appId) {
      appServer.close();
      appServer = null;
      appServerInitialized = false;
    }
    if (!appServer) {
      appServer = createAppServer(env);
      appServerAppId = appId;
      registerAppServerNotifications(appServer);
    }
    if (!appServerInitialized) {
      await appServer.request('initialize', {
        capabilities: null,
        clientInfo: { name: 'shelf', version: '0.0.0', title: 'Shelf' },
      });
      appServerInitialized = true;
    }
    return appServer;
  }

  function registerAppServerNotifications(client: CodexAppServerLike): void {
    const forward = (method: string) => {
      client.onNotification(method, (params) => {
        if (method === 'turn/started') activeTurnId = stringValue(asRecord(asRecord(params)?.turn)?.id) ?? activeTurnId;
        if (method === 'turn/completed') resolveActiveTurn?.();
        if (method === 'thread/tokenUsage/updated') logTokenUsageUpdate(params);
        if (!activeSend) return;
        for (const message of translateCodexAppServerNotification(method, params)) activeSend(message);
      });
    };
    for (const method of [
      'thread/status/changed',
      'turn/started',
      'turn/completed',
      'item/started',
      'item/updated',
      'item/completed',
      'item/agentMessage/delta',
      'thread/tokenUsage/updated',
      'account/rateLimits/updated',
      'mcpServer/startupStatus/updated',
    ]) {
      forward(method);
    }
  }

  function logTokenUsageUpdate(params: unknown): void {
    const p = asRecord(params);
    const summary = summarizeTokenUsageForLog(p?.tokenUsage ?? p?.token_usage ?? p);
    if (!summary) {
      serverLog('debug', 'codex-app-server', 'tokenUsage update without displayable context values');
      return;
    }
    const threadId = stringValue(p?.threadId ?? p?.thread_id) ?? activeThreadId ?? '<unknown>';
    const turnId = stringValue(p?.turnId ?? p?.turn_id) ?? activeTurnId ?? '<unknown>';
    serverLog(
      'info',
      'codex-app-server',
      `tokenUsage thread=${threadId} turn=${turnId} totalTokens=${summary.totalTokens} modelContextWindow=${summary.modelContextWindow} percent=${summary.percent}`,
    );
  }

  function buildCapabilities(
    customModels: ProviderModel[] = [],
    normalizeCurrentModel = false,
    appServerModels?: ProviderCapabilities['models'],
  ): ProviderCapabilities {
    const models = [...(appServerModels?.length ? appServerModels : listBundledModels())];
    const seen = new Set(models.map((model) => model.value));
    for (const model of customModels) {
      if (seen.has(model.id)) continue;
      models.push({ value: model.id, displayName: model.id });
      seen.add(model.id);
    }
    if (normalizeCurrentModel && models.length > 0 && (!currentModel || !seen.has(currentModel))) {
      currentModel = models[0].value;
    }
    return {
      models,
      permissionModes: pickPermissionModes(['default', 'plan', 'bypassPermissions']),
      effortLevels: pickEffortLevels([...CODEX_SDK_EFFORT_LEVELS]),
      slashCommands: [...CODEX_SDK_SLASH_COMMANDS],
      ...(currentModel ? { currentModel } : {}),
      ...(currentEffort ? { currentEffort } : {}),
      ...(currentPermissionMode ? { currentPermissionMode } : {}),
    };
  }

  function applyConfigEdit(key: ConfigEditKey, value: string, send: SendFn): void {
    if (key === 'model') currentModel = value;
    else if (key === 'effort') currentEffort = value;
    else currentPermissionMode = value;
    send({ type: 'capabilities', ...buildCapabilities() });
    send({ type: 'message', msgId: `m-${randomUUID().slice(0, 8)}`, msgType: 'system', content: formatConfigAck(key, value) });
  }

  return {
    async query(input, send): Promise<void> {
      if (activeRun) {
        send({ type: 'error', error: 'codex-offical: a turn is already running' });
        send({ type: 'status', state: 'idle' });
        return;
      }
      if (input.appId) lastAppId = input.appId;
      const runId = Symbol('codex-app-server-run');
      activeRun = runId;
      activeSend = send;
      try {
        if (input.configEdit) {
          applyConfigEdit(input.configEdit.key, input.configEdit.value, send);
          return;
        }

        const slash = parseSlashPrefix(input.prompt);
        if (slash && (slash.cmd === 'model' || slash.cmd === 'effort' || slash.cmd === 'permission')) {
          if (!slash.args) {
            send({ type: 'status', state: 'streaming' });
            send({ type: 'message', msgId: mintSlashMsgId(), msgType: 'error', content: `Usage: /${slash.cmd} <value>` });
            return;
          }
          const key: ConfigEditKey = slash.cmd === 'permission' ? 'permissionMode' : slash.cmd;
          applyConfigEdit(key, slash.args, send);
          return;
        }

        if (slash && (slash.cmd === 'mcp' || slash.cmd === 'skills' || slash.cmd === 'skill' || slash.cmd === 'clear' || slash.cmd === 'compact')) {
          send({ type: 'status', state: 'streaming' });
          const baseEnv = codexEnv(input.appId);
          const sdkHome = codexSdkHome(input.appId);
          if (sdkHome) baseEnv.HOME = sdkHome;
          const client = await ensureAppServer(input.appId, baseEnv);
          if (slash.cmd === 'mcp') {
            const content = formatCodexAppServerMcpCard(await client.request('mcpServerStatus/list', activeThreadId ? { threadId: activeThreadId } : {}));
            send({ type: 'message', msgId: mintSlashMsgId(), msgType: 'reply', content });
            return;
          }
          if (slash.cmd === 'skills' || slash.cmd === 'skill') {
            send({ type: 'message', msgId: mintSlashMsgId(), msgType: 'reply', content: formatCodexAppServerSkillsCard(await client.request('skills/list', { cwds: [input.cwd], forceReload: false })) });
            return;
          }
          if (slash.cmd === 'clear') {
            activeThreadId = null;
            send({ type: 'context_patch', patch: { lastSdkSessionId: null } });
            send({ type: 'message', msgId: mintSlashMsgId(), msgType: 'system', content: 'Cleared Codex app-server session context.' });
            return;
          }
          const threadId = await ensureThread(client, input, send, baseEnv);
          await waitForTurnCompletion(() => client.request('thread/compact/start', { threadId }));
          return;
        }

        const baseEnv = codexEnv(input.appId);
        const sdkHome = codexSdkHome(input.appId);
        if (sdkHome) baseEnv.HOME = sdkHome;
        const client = await ensureAppServer(input.appId, baseEnv);
        const threadId = await ensureThread(client, input, send, baseEnv);
        await waitForTurnCompletion(async () => {
          const started = await client.request('turn/start', {
            threadId,
            clientUserMessageId: `shelf-${randomUUID()}`,
            input: toCodexAppServerInput(input.prompt, input.images),
            ...turnOverrides(input),
          });
          activeTurnId = stringValue(asRecord(asRecord(started)?.turn)?.id) ?? activeTurnId;
        });
      } catch (err) {
        send({ type: 'error', error: `codex-offical: ${(err as Error)?.message ?? String(err)}` });
      } finally {
        if (activeRun === runId) {
          activeRun = null;
          activeSend = null;
          resolveActiveTurn = null;
          activeTurnId = null;
        }
        send({ type: 'status', state: 'idle' });
      }
    },

    async gatherCapabilities(
      _cwd,
      _sessionId,
      customModels,
      intent,
      _cache,
      appId,
    ): Promise<ProviderCapabilities> {
      if (appId) lastAppId = appId;
      if (intent?.model) currentModel = intent.model;
      if (intent?.effort) currentEffort = intent.effort;
      if (intent?.permissionMode) currentPermissionMode = intent.permissionMode;
      const baseEnv = codexEnv(appId);
      const sdkHome = codexSdkHome(appId);
      if (sdkHome) baseEnv.HOME = sdkHome;
      try {
        const client = await ensureAppServer(appId, baseEnv);
        return buildCapabilities(customModels, true, await listAppServerModels(client));
      } catch (err) {
        serverLog('warn', 'codex-app-server', `model/list failed; using bundled fallback: ${(err as Error)?.message ?? String(err)}`);
        return buildCapabilities(customModels, true);
      }
    },

    setModel(model): void { currentModel = model; },
    setEffort(effort): void { currentEffort = effort; },
    setPermissionMode(mode): void { currentPermissionMode = mode; },

    startLogin(_cwd: string, send: SendFn): void {
      loginHandle?.cancel();
      const { rpc } = spawnLoginRpc(codexEnv(lastAppId));
      loginHandle = driveDeviceCodeLogin(rpc, send, CODEX_OFFICAL_PROVIDER);
    },

    cancelLogin(): void {
      loginHandle?.cancel();
      loginHandle = null;
    },

    skillTarget(appId): string | undefined {
      return codexSdkSkillTarget(appId);
    },

    refreshAccountStatus(cache, send, appId): Promise<void> {
      return refreshAccount(cache, send, appId);
    },

    configHome(appId): string | undefined {
      return codexConfigHome(appId);
    },

    async stop(): Promise<void> {
      if (appServer && activeThreadId && activeTurnId) {
        await appServer.request('turn/interrupt', { threadId: activeThreadId, turnId: activeTurnId }).catch((err) => {
          serverLog('warn', 'codex-app-server', `turn/interrupt failed: ${(err as Error)?.message ?? String(err)}`);
        });
      }
      resolveActiveTurn?.();
    },

    reconnect(): void {
      resolveActiveTurn?.();
    },

    dispose(): void {
      resolveActiveTurn?.();
      appServer?.close();
      appServer = null;
      appServerInitialized = false;
      loginHandle?.cancel();
      loginHandle = null;
    },
  };

  async function ensureThread(
    client: CodexAppServerLike,
    input: Parameters<ServerBackend['query']>[0],
    send: SendFn,
    baseEnv: NodeJS.ProcessEnv,
  ): Promise<string> {
        const mcp = loadMcpServers(input.appId, baseEnv);
        if (mcp.errors.length) {
          throw new Error(mcp.errors.join('; '));
        }
        const shelfMcp = await getShelfMcp();
        const sdkHome = codexSdkHome(input.appId);
        const mapped = buildCodexSdkRuntimeConfig({
          cwd: input.cwd,
          model: input.model ?? currentModel,
          effort: input.effort ?? currentEffort,
          permissionMode: input.permissionMode ?? currentPermissionMode,
          baseEnv,
          mcpServers: mcp.servers,
          shelfMcp: shelfMcp ?? undefined,
          additionalDirectories: sdkHome ? [sdkHome] : undefined,
        });
        if (!mapped.ok) {
          throw new Error(mapped.errors.join('; '));
        }
        const resumeId = input.restoreContext?.lastSdkSessionId;
        const params = {
          ...threadOverrides(input),
          config: Object.keys(mapped.codexOptions.config).length ? mapped.codexOptions.config : undefined,
        };
        const response = resumeId
          ? await client.request('thread/resume', { threadId: resumeId, ...params })
          : await client.request('thread/start', { ...params, sessionStartSource: 'startup' });
        const threadId = stringValue(asRecord(asRecord(response)?.thread)?.id);
        if (!threadId) throw new Error('app-server did not return a thread id');
        if (resumeId && threadId !== resumeId) {
          throw new Error(`resume thread mismatch (requested ${resumeId}, got ${threadId})`);
        }
        activeThreadId = threadId;
        send({ type: 'context_patch', patch: { lastSdkSessionId: threadId } });
        send({ type: 'status', state: 'streaming', sessionId: threadId });
        return threadId;
    }

  function waitForTurnCompletion(start: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      resolveActiveTurn = resolve;
      start().catch((err) => {
        resolveActiveTurn = null;
        reject(err);
      });
    });
  }

  function threadOverrides(input: Parameters<ServerBackend['query']>[0]): Record<string, unknown> {
    return {
      cwd: input.cwd,
      ...(input.model ?? currentModel ? { model: input.model ?? currentModel } : {}),
      ...threadPermissionOverrides(input.permissionMode ?? currentPermissionMode),
    };
  }

  function turnOverrides(input: Parameters<ServerBackend['query']>[0]): Record<string, unknown> {
    return {
      cwd: input.cwd,
      ...(input.model ?? currentModel ? { model: input.model ?? currentModel } : {}),
      ...(input.effort ?? currentEffort ? { effort: input.effort ?? currentEffort } : {}),
      ...turnPermissionOverrides(input.permissionMode ?? currentPermissionMode),
    };
  }

  function threadPermissionOverrides(mode: string | undefined): Record<string, unknown> {
    switch (mode) {
      case 'plan':
        return { approvalPolicy: 'never', sandbox: 'read-only' };
      case 'default':
        return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
      case 'bypassPermissions':
        return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
      case undefined:
        return {};
      default:
        throw new Error(`Unsupported Codex app-server permission mode: ${mode}`);
    }
  }

  function turnPermissionOverrides(mode: string | undefined): Record<string, unknown> {
    switch (mode) {
      case 'plan':
        return { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
      case 'default':
        return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
      case 'bypassPermissions':
        return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
      case undefined:
        return {};
      default:
        throw new Error(`Unsupported Codex app-server permission mode: ${mode}`);
    }
  }

  async function listAppServerModels(client: CodexAppServerLike): Promise<ProviderCapabilities['models']> {
    const out: ProviderCapabilities['models'] = [];
    let cursor: string | null | undefined = null;
    do {
      const response = asRecord(await client.request('model/list', { ...(cursor ? { cursor } : {}), includeHidden: false }));
      for (const model of asArray(response?.data)) {
        const record = asRecord(model);
        const value = stringValue(record?.model ?? record?.id);
        if (!value) continue;
        out.push({
          value,
          displayName: stringValue(record?.displayName) ?? value,
          effortLevels: normalizeAppServerEfforts(record?.supportedReasoningEfforts),
        });
        if (record?.isDefault === true && !currentModel) currentModel = value;
      }
      cursor = stringValue(response?.nextCursor);
    } while (cursor);
    return out;
  }

  function normalizeAppServerEfforts(raw: unknown): ProviderCapabilities['effortLevels'] {
    return asArray(raw)
      .map((entry) => stringValue(asRecord(entry)?.reasoningEffort))
      .filter((value): value is string => !!value)
      .map((value) => ({ value, displayName: value }));
  }
}

function toCodexAppServerInput(prompt: string, images: string[] = []): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  if (prompt.trim()) input.push({ type: 'text', text: prompt, text_elements: [] });
  for (const image of images) input.push({ type: 'localImage', path: image });
  return input;
}

function formatCodexAppServerMcpCard(raw: unknown): string {
  const rows = asArray(asRecord(raw)?.data)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => !!entry)
    .map((entry) => [`\`${mdCell(stringValue(entry.name) ?? 'unknown')}\``, mdCell(stringValue(entry.authStatus) ?? 'loaded')]);
  if (rows.length === 0) return 'No MCP servers loaded for Codex app-server.';
  return `${rows.length} MCP server${rows.length > 1 ? 's' : ''}:\n\n${mdTable(['Server', 'Status'], rows)}`;
}

function formatCodexAppServerSkillsCard(raw: unknown): string {
  const lines: string[] = [];
  for (const entry of asArray(asRecord(raw)?.data)) {
    const record = asRecord(entry);
    for (const skill of asArray(record?.skills)) {
      const item = asRecord(skill);
      const name = stringValue(item?.name);
      if (!name) continue;
      const description = stringValue(item?.shortDescription) ?? stringValue(item?.description) ?? '';
      lines.push(`- \`${name}\`${description ? ` — ${description}` : ''}`);
    }
    for (const error of asArray(record?.errors)) {
      lines.push(`- error: ${mdCell(JSON.stringify(error))}`);
    }
  }
  if (lines.length === 0) return 'No skills loaded for Codex app-server.';
  return `${lines.length} skill${lines.length > 1 ? 's' : ''}:\n\n${lines.join('\n')}`;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function mintSlashMsgId(): string {
  return `slash-${randomUUID().slice(0, 8)}`;
}

function mdTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(mdCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`),
  ].join('\n');
}

function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function listCodexBundledModels(): ProviderCapabilities['models'] {
  try {
    const { command, args } = resolveCodexCliCommand();
    const result = spawnSync(command, [...args, 'debug', 'models', '--bundled'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: codexEnv(undefined),
    });
    if (result.status !== 0) {
      serverLog('warn', 'codex-offical', `codex debug models --bundled failed: ${result.stderr || `exit ${result.status}`}`);
      return [];
    }
    const parsed = JSON.parse(result.stdout) as { models?: Array<{ slug?: unknown; display_name?: unknown; supported_reasoning_levels?: Array<{ effort?: unknown }> }> };
    return (parsed.models ?? [])
      .filter((model): model is { slug: string; display_name?: string; supported_reasoning_levels?: Array<{ effort?: unknown }> } => typeof model.slug === 'string')
      .map((model) => ({
        value: model.slug,
        displayName: typeof model.display_name === 'string' ? model.display_name : model.slug,
        effortLevels: pickEffortLevels(
          (model.supported_reasoning_levels ?? [])
            .map((level) => level.effort)
            .filter((effort): effort is string => typeof effort === 'string' && (CODEX_SDK_EFFORT_LEVELS as readonly string[]).includes(effort)),
        ),
      }));
  } catch (err) {
    serverLog('warn', 'codex-offical', `failed to list bundled Codex models: ${(err as Error)?.message ?? String(err)}`);
    return [];
  }
}
