import { CODEX_OFFICAL_PROVIDER } from '@shared/agent-providers';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentAttachment, ProviderModel } from '@shared/types';
import { parseSlashPrefix } from '@shared/slash-prefix';
import { codexConfigHome, codexEnv, resolveCodexCliCommand } from '../codex-shared/runtime';
import { driveDeviceCodeLogin, spawnCodexAppServerRpc, type LoginHandle, type LoginRpc } from '../codex-shared/app-server-login';
import { pickEffortLevels, pickPermissionModes, type ProviderCapabilities, type SendFn, type ServerBackend } from '../types';
import { formatConfigAck, type ConfigEditKey } from '@shared/config-ack';
import { CODEX_SDK_EFFORT_LEVELS, buildCodexSdkRuntimeConfig } from './config';
import { normalizeCodexAccountStatus, redactCodexAccountText, refreshCodexAccountStatus } from './account-status';
import { spawnCodexAppServerClient, type CodexAppServerNotificationHandler } from './app-server-client';
import { summarizeTokenUsageForLog, translateCodexAppServerNotification } from './app-server-translate';
import { loadProjectedMcpServers, type ParsedMcpConfig } from '../mcp-config';
import { getSharedShelfMcp } from '../acp/shelf-mcp';
import { serverLog } from '../../server-logger';

interface CodexAppServerLike {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  onNotification(method: string, handler: CodexAppServerNotificationHandler): void;
  onRequest?(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void;
  close(): void;
}

interface ApprovalResolution {
  allow: boolean;
  message?: string;
  scope?: 'once' | 'session';
  cancelled?: boolean;
}

const CODEX_SDK_SLASH_COMMANDS = [
  { name: 'status', description: 'Show current Codex session status' },
  { name: 'usage', description: 'Show Codex account usage and quota limits' },
  { name: 'mcp', description: 'List loaded MCP servers' },
  { name: 'skills', description: 'List loaded skills' },
  { name: 'skill', description: 'List loaded skills' },
  { name: 'compact', description: 'Compact Codex thread context' },
  { name: 'clear', description: 'Clear Codex session context' },
  { name: 'new', description: 'Start a new Codex thread for the next turn' },
  { name: 'review', description: 'Review uncommitted changes' },
  { name: 'diff', description: 'Show git diff to remote' },
  { name: 'goal', description: 'Get, set, or clear the current Codex goal' },
  { name: 'rename', description: 'Rename the current Codex thread' },
  { name: 'logout', description: 'Log out of the current Codex account' },
  { name: 'ps', description: 'List background Codex tasks' },
  { name: 'stop', description: 'Stop a background Codex task' },
  { name: 'clean', description: 'Clean completed background Codex tasks' },
] as const;

const CODEX_APP_SERVER_SLASH_COMMAND_NAMES = new Set<string>(CODEX_SDK_SLASH_COMMANDS.map((command) => command.name));
const UNSUPPORTED_APP_SERVER_SLASH_COMMANDS = new Set(['ps', 'stop', 'clean']);

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
  const commandMetadataByItemId = new Map<string, { command?: string }>();
  const commandOutputByItemId = new Map<string, string>();
  const reasoningByItemId = new Map<string, string>();
  const pendingPermissionRequests = new Map<string, {
    resolve: (value: ApprovalResolution) => void;
    toolName: string;
  }>();
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
      registerAppServerRequests(appServer);
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
        if (method === 'turn/started') {
          activeTurnId = stringValue(asRecord(asRecord(params)?.turn)?.id) ?? activeTurnId;
          commandMetadataByItemId.clear();
          commandOutputByItemId.clear();
          reasoningByItemId.clear();
        }
        if (method === 'turn/completed') resolveActiveTurn?.();
        if (method === 'thread/tokenUsage/updated') logTokenUsageUpdate(params);
        if (!activeSend) return;
        if (method === 'item/commandExecution/outputDelta') {
          const message = translateCommandOutputDelta(params);
          if (message) activeSend(message);
          return;
        }
        if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
          const message = translateReasoningDelta(params);
          logReasoningNotification(method, params, message ? [message] : []);
          if (message) activeSend(message);
          return;
        }
        const translatedParams = method === 'item/started' || method === 'item/updated' || method === 'item/completed'
          ? carryAppServerItemState(params)
          : params;
        const messages = translateCodexAppServerNotification(method, translatedParams);
        if (method === 'item/started' || method === 'item/updated' || method === 'item/completed') {
          logReasoningNotification(method, translatedParams, messages);
        }
        for (const message of messages) activeSend(message);
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
      'item/commandExecution/outputDelta',
      'item/reasoning/summaryTextDelta',
      'item/reasoning/textDelta',
      'item/reasoning/summaryPartAdded',
      'thread/tokenUsage/updated',
      'account/rateLimits/updated',
      'mcpServer/startupStatus/updated',
    ]) {
      forward(method);
    }
  }

  function translateReasoningDelta(params: unknown): Parameters<SendFn>[0] | null {
    const p = asRecord(params);
    const itemId = stringValue(p?.itemId ?? p?.item_id);
    const delta = stringValue(p?.delta);
    if (!itemId || delta == null) return null;
    const text = `${reasoningByItemId.get(itemId) ?? ''}${delta}`;
    reasoningByItemId.set(itemId, text);
    if (!text.trim()) return null;
    return {
      type: 'message',
      msgId: itemId,
      msgType: 'fold_text',
      label: 'Reasoning',
      body: { content: redactCodexAccountText(text), tone: 'muted' },
    };
  }

  function logReasoningNotification(method: string, params: unknown, messages: Parameters<SendFn>[0][]): void {
    const item = asRecord(asRecord(params)?.item) ?? asRecord(params);
    const itemType = stringValue(item?.type);
    const isReasoningDelta = method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta';
    if (itemType !== 'reasoning' && !isReasoningDelta) return;
    const itemId = stringValue(item?.id ?? item?.itemId ?? item?.item_id) ?? '<unknown>';
    const delta = stringValue(item?.delta);
    const reasoningSummary = asArray(item?.summary).map(stringValue).filter((value): value is string => !!value).join('');
    const reasoningContent = asArray(item?.content).map(stringValue).filter((value): value is string => !!value).join('');
    const route = messages.map((message) => {
      if (message.type === 'message') return message.msgType;
      if (message.type === 'stream') return `stream:${message.streamType}`;
      return message.type;
    }).join(',') || 'ignored';
    serverLog(
      'debug',
      'codex-app-server',
      `reasoning-notification method=${method} itemId=${itemId} route=${route} deltaLen=${delta?.length ?? 0} reasoningLen=${reasoningSummary.length + reasoningContent.length}`,
    );
  }

  function translateCommandOutputDelta(params: unknown): Parameters<SendFn>[0] | null {
    const p = asRecord(params);
    const itemId = stringValue(p?.itemId ?? p?.item_id);
    const delta = stringValue(p?.delta);
    if (!itemId || delta == null) return null;
    const output = `${commandOutputByItemId.get(itemId) ?? ''}${delta}`;
    commandOutputByItemId.set(itemId, output);
    const meta = commandMetadataByItemId.get(itemId);
    return {
      type: 'message',
      msgId: itemId,
      msgType: 'fold_code',
      label: 'Command',
      ...(meta?.command ? { subtitle: redactCodexAccountText(meta.command) } : {}),
      body: { content: redactCodexAccountText(output) },
    };
  }

  function carryAppServerItemState(params: unknown): unknown {
    const outer = asRecord(params);
    const item = asRecord(outer?.item);
    if (!outer || !item) return params;
    const itemType = stringValue(item.type);
    const itemId = stringValue(item.id);
    if (!itemId) return params;
    if (itemType === 'reasoning') {
      const carried = reasoningByItemId.get(itemId);
      if (!carried) return params;
      return {
        ...outer,
        item: {
          ...item,
          summary: [carried],
        },
      };
    }
    if (itemType !== 'commandExecution' && itemType !== 'command_execution') return params;
    const command = stringValue(item.command);
    if (command) commandMetadataByItemId.set(itemId, { command });
    const aggregate = stringValue(item.aggregatedOutput ?? item.aggregated_output);
    if (aggregate) commandOutputByItemId.set(itemId, aggregate);
    const carried = commandOutputByItemId.get(itemId);
    if (!carried || aggregate) return params;
    return {
      ...outer,
      item: {
        ...item,
        aggregatedOutput: carried,
      },
    };
  }

  function registerAppServerRequests(client: CodexAppServerLike): void {
    if (!client.onRequest) {
      serverLog('warn', 'codex-app-server', 'app-server client does not support server request handlers');
      return;
    }
    client.onRequest('item/commandExecution/requestApproval', (params) => handleCommandApprovalRequest(params));
    client.onRequest('item/fileChange/requestApproval', (params) => handleFileChangeApprovalRequest(params));
    client.onRequest('item/permissions/requestApproval', (params) => handlePermissionProfileApprovalRequest(params));
    client.onRequest('execCommandApproval', (params) => handleLegacyExecApprovalRequest(params));
    client.onRequest('applyPatchApproval', (params) => handleLegacyApplyPatchApprovalRequest(params));
    client.onRequest('mcpServer/elicitation/request', (params) => {
      serverLog('warn', 'codex-app-server', `unsupported MCP elicitation request: ${redactCodexAccountText(formatJsonForLog(summarizeApprovalInput(params)).slice(0, 500))}`);
      return { action: 'cancel', content: null, _meta: null };
    });
  }

  async function handleCommandApprovalRequest(params: unknown): Promise<Record<string, unknown>> {
    const p = asRecord(params);
    const toolUseId = stringValue(p?.approvalId) ?? stringValue(p?.itemId) ?? `codex-approval-${randomUUID()}`;
    const command = stringValue(p?.command) ?? 'command';
    const resolution = await requestPermission(toolUseId, 'Command', {
      command,
      cwd: stringValue(p?.cwd),
      reason: stringValue(p?.reason),
      commandActions: asArray(p?.commandActions),
    });
    return { decision: resolutionToAppServerDecision(resolution) };
  }

  async function handleFileChangeApprovalRequest(params: unknown): Promise<Record<string, unknown>> {
    const p = asRecord(params);
    const toolUseId = stringValue(p?.itemId) ?? `codex-file-approval-${randomUUID()}`;
    const resolution = await requestPermission(toolUseId, 'File changes', {
      reason: stringValue(p?.reason),
      grantRoot: stringValue(p?.grantRoot),
    });
    return { decision: resolutionToAppServerDecision(resolution) };
  }

  async function handlePermissionProfileApprovalRequest(params: unknown): Promise<Record<string, unknown>> {
    const p = asRecord(params);
    const permissions = asRecord(p?.permissions) ?? {};
    const toolUseId = stringValue(p?.itemId) ?? `codex-permission-approval-${randomUUID()}`;
    const resolution = await requestPermission(toolUseId, 'Permissions', {
      cwd: stringValue(p?.cwd),
      reason: stringValue(p?.reason),
      permissions,
    });
    if (!resolution.allow) return { permissions: {}, scope: 'turn', strictAutoReview: true };
    const granted: Record<string, unknown> = {};
    if (permissions.network) granted.network = permissions.network;
    if (permissions.fileSystem) granted.fileSystem = permissions.fileSystem;
    return { permissions: granted, scope: resolution.scope === 'session' ? 'session' : 'turn', strictAutoReview: false };
  }

  async function handleLegacyExecApprovalRequest(params: unknown): Promise<Record<string, unknown>> {
    const p = asRecord(params);
    const command = asArray(p?.command).map((part) => String(part)).join(' ') || 'command';
    const toolUseId = stringValue(p?.approvalId) ?? stringValue(p?.callId) ?? `codex-exec-approval-${randomUUID()}`;
    const resolution = await requestPermission(toolUseId, 'Command', {
      command,
      cwd: stringValue(p?.cwd),
      reason: stringValue(p?.reason),
      parsedCmd: asArray(p?.parsedCmd),
    });
    return { decision: resolutionToLegacyReviewDecision(resolution) };
  }

  async function handleLegacyApplyPatchApprovalRequest(params: unknown): Promise<Record<string, unknown>> {
    const p = asRecord(params);
    const toolUseId = stringValue(p?.callId) ?? `codex-patch-approval-${randomUUID()}`;
    const resolution = await requestPermission(toolUseId, 'File changes', {
      reason: stringValue(p?.reason),
      grantRoot: stringValue(p?.grantRoot),
      fileChanges: asRecord(p?.fileChanges) ?? {},
    });
    return { decision: resolutionToLegacyReviewDecision(resolution) };
  }

  function requestPermission(toolUseId: string, toolName: string, input: Record<string, unknown>): Promise<ApprovalResolution> {
    if (!activeSend) {
      serverLog('warn', 'codex-app-server', `approval requested without active turn: ${toolName} ${toolUseId}`);
      return Promise.resolve({ allow: false, cancelled: true });
    }
    if (pendingPermissionRequests.has(toolUseId)) {
      serverLog('warn', 'codex-app-server', `duplicate approval id from app-server: ${toolUseId}`);
      return Promise.resolve({ allow: false, cancelled: true });
    }
    activeSend({ type: 'permission_request', toolUseId, toolName, input });
    return new Promise((resolve) => {
      pendingPermissionRequests.set(toolUseId, { resolve, toolName });
    });
  }

  function resolutionToAppServerDecision(resolution: ApprovalResolution): string {
    if (resolution.cancelled) return 'cancel';
    if (!resolution.allow) return 'decline';
    return resolution.scope === 'session' ? 'acceptForSession' : 'accept';
  }

  function resolutionToLegacyReviewDecision(resolution: ApprovalResolution): unknown {
    if (resolution.cancelled) return 'abort';
    if (!resolution.allow) return { denied: { rejection: resolution.message ?? 'Denied by user' } };
    return resolution.scope === 'session' ? 'approved_for_session' : 'approved';
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
      `tokenUsage thread=${threadId} turn=${turnId} cumulativeTotalTokens=${summary.cumulativeTotalTokens ?? 'null'} lastInputTokens=${summary.lastInputTokens ?? 'null'} lastTotalTokens=${summary.lastTotalTokens ?? 'null'} modelContextWindow=${summary.modelContextWindow} cumulativePercent=${summary.cumulativePercent ?? 'null'} lastPercent=${summary.lastPercent ?? 'null'}`,
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

        if (slash && CODEX_APP_SERVER_SLASH_COMMAND_NAMES.has(slash.cmd)) {
          send({ type: 'status', state: 'streaming' });
          const baseEnv = codexEnv(input.appId);
          const sdkHome = codexSdkHome(input.appId);
          if (sdkHome) baseEnv.HOME = sdkHome;
          const client = await ensureAppServer(input.appId, baseEnv);
          if (slash.cmd === 'status') {
            sendSlashMessage(send, 'reply', formatCodexAppServerStatusCard(input, activeThreadId, {
              model: currentModel,
              effort: currentEffort,
              permissionMode: currentPermissionMode,
            }));
            return;
          }
          if (slash.cmd === 'usage') {
            const [rateLimits, usage] = await Promise.all([
              client.request('account/rateLimits/read'),
              client.request('account/usage/read'),
            ]);
            sendSlashMessage(send, 'reply', formatCodexAppServerUsageCard(rateLimits, usage));
            return;
          }
          if (slash.cmd === 'mcp') {
            const content = formatCodexAppServerMcpCard(await client.request('mcpServerStatus/list', activeThreadId ? { threadId: activeThreadId } : {}));
            sendSlashMessage(send, 'reply', content);
            return;
          }
          if (slash.cmd === 'skills' || slash.cmd === 'skill') {
            sendSlashMessage(send, 'reply', formatCodexAppServerSkillsCard(await client.request('skills/list', { cwds: [input.cwd], forceReload: false })));
            return;
          }
          if (slash.cmd === 'clear' || slash.cmd === 'new') {
            activeThreadId = null;
            send({ type: 'context_patch', patch: { lastSdkSessionId: null } });
            sendSlashMessage(send, 'system', slash.cmd === 'new' ? 'Started a new Codex thread for the next turn.' : 'Cleared Codex app-server session context.');
            return;
          }
          if (slash.cmd === 'diff') {
            sendSlashMessage(send, 'reply', formatCodexAppServerDiffCard(await client.request('gitDiffToRemote', { cwd: input.cwd })));
            return;
          }
          if (slash.cmd === 'logout') {
            await client.request('account/logout');
            activeThreadId = null;
            send({ type: 'context_patch', patch: { lastSdkSessionId: null } });
            sendSlashMessage(send, 'system', 'Logged out of Codex.');
            return;
          }
          if (UNSUPPORTED_APP_SERVER_SLASH_COMMANDS.has(slash.cmd)) {
            sendSlashMessage(send, 'error', `/${slash.cmd} is not available through the current Codex app-server schema yet.`);
            return;
          }
          const threadId = await ensureThread(client, input, send, baseEnv);
          if (slash.cmd === 'compact') {
            await waitForTurnCompletion(() => client.request('thread/compact/start', { threadId }));
            return;
          }
          if (slash.cmd === 'review') {
            await waitForTurnCompletion(() => client.request('review/start', { threadId, target: { type: 'uncommittedChanges' } }));
            return;
          }
          if (slash.cmd === 'goal') {
            await handleGoalSlash(client, threadId, slash.args, send);
            return;
          }
          if (slash.cmd === 'rename') {
            if (!slash.args) {
              sendSlashMessage(send, 'error', 'Usage: /rename <thread name>');
              return;
            }
            await client.request('thread/name/set', { threadId, name: slash.args });
            sendSlashMessage(send, 'system', `Renamed Codex thread to "${redactCodexAccountText(slash.args)}".`);
            return;
          }
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
            input: toCodexAppServerInput(input.prompt, input.images, input.attachments),
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

    resolvePermission(toolUseId, allow, message, scope): void {
      const pending = pendingPermissionRequests.get(toolUseId);
      if (!pending) {
        serverLog('warn', 'codex-app-server', `resolvePermission for unknown approval id: ${toolUseId}`);
        return;
      }
      pendingPermissionRequests.delete(toolUseId);
      pending.resolve({ allow, message, scope });
    },

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
      for (const [toolUseId, pending] of pendingPermissionRequests) {
        serverLog('warn', 'codex-app-server', `disposing unresolved approval id: ${toolUseId} (${pending.toolName})`);
        pending.resolve({ allow: false, cancelled: true });
      }
      pendingPermissionRequests.clear();
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

  async function handleGoalSlash(client: CodexAppServerLike, threadId: string, args: string, send: SendFn): Promise<void> {
    const trimmed = args.trim();
    if (!trimmed) {
      sendSlashMessage(send, 'reply', formatCodexAppServerGoalCard(await client.request('thread/goal/get', { threadId })));
      return;
    }
    if (trimmed === 'clear') {
      await client.request('thread/goal/clear', { threadId });
      sendSlashMessage(send, 'system', 'Cleared Codex goal.');
      return;
    }
    await client.request('thread/goal/set', { threadId, objective: trimmed });
    sendSlashMessage(send, 'system', `Set Codex goal: ${redactCodexAccountText(trimmed)}`);
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

function toCodexAppServerInput(prompt: string, images: string[] = [], attachments: AgentAttachment[] = []): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  if (prompt.trim()) input.push({ type: 'text', text: prompt, text_elements: [] });
  for (const image of images) {
    if (isImageDataUrl(image)) {
      throw new Error('data URL images must be uploaded before reaching Codex app-server');
    }
    input.push(isCodexAppServerImageUrl(image)
      ? { type: 'image', url: image }
      : { type: 'localImage', path: image });
  }
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      input.push({ type: 'localImage', path: attachment.path });
    }
  }
  return input;
}

function isCodexAppServerImageUrl(image: string): boolean {
  return /^https?:\/\//i.test(image);
}

function isImageDataUrl(image: string): boolean {
  return /^data:image\/[^;,]+;base64,/i.test(image);
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

function formatCodexAppServerStatusCard(
  input: Parameters<ServerBackend['query']>[0],
  activeThreadId: string | null,
  current: { model?: string; effort?: string; permissionMode?: string },
): string {
  const rows = [
    ['Provider', CODEX_OFFICAL_PROVIDER],
    ['Thread', activeThreadId ?? input.restoreContext?.lastSdkSessionId ?? 'none'],
    ['Model', input.model ?? current.model ?? 'provider default'],
    ['Effort', input.effort ?? current.effort ?? 'provider default'],
    ['Permission', input.permissionMode ?? current.permissionMode ?? 'provider default'],
    ['CWD', input.cwd],
  ];
  return `Codex status:\n\n${mdTable(['Field', 'Value'], rows.map(([key, value]) => [key, redactCodexAccountText(value)]))}`;
}

function formatCodexAppServerUsageCard(rateLimits: unknown, usage: unknown): string {
  const normalized = normalizeCodexAccountStatus({ account: null, rateLimits, usage });
  const lines: string[] = [];
  if (normalized?.rateLimits.length) {
    lines.push('Quota limits:');
    for (const segment of normalized.rateLimits) lines.push(`- ${redactCodexAccountText(segment.text)}`);
  } else {
    lines.push('Quota limits: no rate-limit buckets returned.');
  }

  const usageSummary = summarizeCodexUsage(usage);
  lines.push('', 'Account usage:');
  if (usageSummary.length) {
    for (const row of usageSummary) lines.push(`- ${row}`);
  } else {
    lines.push('- No displayable usage counters returned.');
  }
  return lines.join('\n');
}

function summarizeCodexUsage(raw: unknown): string[] {
  const record = asRecord(raw);
  if (!record) return [];
  const candidates = [
    ['Total tokens', record.totalTokens ?? record.total_tokens ?? record.lifetimeTokens ?? record.lifetime_tokens],
    ['Input tokens', record.inputTokens ?? record.input_tokens],
    ['Output tokens', record.outputTokens ?? record.output_tokens],
    ['Requests', record.requests ?? record.requestCount ?? record.request_count],
    ['Current streak', record.currentStreak ?? record.current_streak],
  ];
  return candidates
    .map(([label, value]) => {
      const n = numberValue(value);
      if (n == null) return null;
      return `${label}: ${new Intl.NumberFormat('en-US').format(n)}`;
    })
    .filter((line): line is string => !!line);
}

function formatCodexAppServerDiffCard(raw: unknown): string {
  const record = asRecord(raw);
  const diff = stringValue(record?.diff ?? record?.text ?? record?.content) ?? (typeof raw === 'string' ? raw : null);
  if (!diff?.trim()) return 'No git diff to remote returned.';
  return `Git diff to remote:\n\n\`\`\`diff\n${redactCodexAccountText(diff).slice(0, 20_000)}\n\`\`\``;
}

function formatCodexAppServerGoalCard(raw: unknown): string {
  const record = asRecord(raw);
  const goal = asRecord(record?.goal) ?? record;
  const objective = stringValue(goal?.objective);
  const status = stringValue(goal?.status);
  const tokenBudget = numberValue(goal?.tokenBudget ?? goal?.token_budget);
  if (!objective && !status && tokenBudget == null) return 'No Codex goal is set.';
  const rows = [
    ...(objective ? [['Objective', redactCodexAccountText(objective)]] : []),
    ...(status ? [['Status', status]] : []),
    ...(tokenBudget != null ? [['Token budget', new Intl.NumberFormat('en-US').format(tokenBudget)]] : []),
  ];
  return `Codex goal:\n\n${mdTable(['Field', 'Value'], rows)}`;
}

function summarizeApprovalInput(raw: unknown): Record<string, unknown> {
  const record = asRecord(raw);
  if (!record) return {};
  const out: Record<string, unknown> = {};
  for (const key of ['threadId', 'turnId', 'itemId', 'approvalId', 'serverName', 'mode', 'message', 'url', 'reason', 'cwd', 'grantRoot']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value == null) out[key] = value;
  }
  return out;
}

function formatJsonForLog(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable]';
  }
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

function numberValue(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function mintSlashMsgId(): string {
  return `slash-${randomUUID().slice(0, 8)}`;
}

function sendSlashMessage(send: SendFn, msgType: 'reply' | 'system' | 'error', content: string): void {
  send({ type: 'message', msgId: mintSlashMsgId(), msgType, content });
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
