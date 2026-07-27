import { CODEX_OFFICAL_PROVIDER } from '@shared/agent-providers';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Codex, type CodexOptions, type Input, type ThreadEvent, type ThreadOptions, type TurnOptions } from '@openai/codex-sdk';
import type { ProviderModel } from '@shared/types';
import { codexConfigHome, codexEnv, resolveCodexCliCommand } from '../codex-shared/runtime';
import { driveDeviceCodeLogin, spawnCodexAppServerRpc, type LoginHandle, type LoginRpc } from '../codex-shared/app-server-login';
import { pickEffortLevels, pickPermissionModes, type ProviderCapabilities, type SendFn, type ServerBackend } from '../types';
import { formatConfigAck, type ConfigEditKey } from '@shared/config-ack';
import { CODEX_SDK_EFFORT_LEVELS, buildCodexSdkRuntimeConfig, toCodexSdkInput } from './config';
import { resolveCodexSdkCodexPathOverride } from './runtime';
import { translateCodexThreadEvent } from './translate';
import { loadProjectedMcpServers, type ParsedMcpConfig } from '../mcp-config';
import { getSharedShelfMcp } from '../acp/shelf-mcp';
import { serverLog } from '../../server-logger';

interface CodexThreadLike {
  runStreamed(input: Input, options?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export interface CodexOfficialDeps {
  spawnLoginRpc?: (env: NodeJS.ProcessEnv) => { rpc: LoginRpc };
  createClient?: (options: CodexOptions) => CodexClientLike;
  resolveCodexPath?: () => string;
  getShelfMcp?: () => Promise<{ url: string } | null>;
  loadMcpServers?: (appId: string | undefined, env?: Record<string, string | undefined>) => ParsedMcpConfig;
  listBundledModels?: () => ProviderCapabilities['models'];
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
  let activeController: AbortController | null = null;
  let activeRun: symbol | null = null;
  const spawnLoginRpc = deps.spawnLoginRpc ?? ((env: NodeJS.ProcessEnv) => spawnCodexAppServerRpc(env));
  const createClient = deps.createClient ?? ((options: CodexOptions) => new Codex(options));
  const resolveCodexPath = deps.resolveCodexPath ?? resolveCodexSdkCodexPathOverride;
  const getShelfMcp = deps.getShelfMcp ?? getSharedShelfMcp;
  const loadMcpServers = deps.loadMcpServers ?? loadProjectedMcpServers;
  const listBundledModels = deps.listBundledModels ?? listCodexBundledModels;

  function buildCapabilities(customModels: ProviderModel[] = []): ProviderCapabilities {
    const models = [...listBundledModels()];
    const seen = new Set(models.map((model) => model.value));
    for (const model of customModels) {
      if (seen.has(model.id)) continue;
      models.push({ value: model.id, displayName: model.id });
      seen.add(model.id);
    }
    return {
      models,
      permissionModes: pickPermissionModes(['default', 'plan', 'bypassPermissions']),
      effortLevels: pickEffortLevels([...CODEX_SDK_EFFORT_LEVELS]),
      slashCommands: [],
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
      const runId = Symbol('codex-sdk-run');
      const controller = new AbortController();
      activeRun = runId;
      activeController = controller;
      try {
        if (input.configEdit) {
          applyConfigEdit(input.configEdit.key, input.configEdit.value, send);
          return;
        }

        const sdkInput = toCodexSdkInput(input.prompt, input.images);
        if (!sdkInput.ok) {
          send({ type: 'error', error: `codex-offical: ${sdkInput.error}` });
          return;
        }

        const baseEnv = codexEnv(input.appId);
        const sdkHome = codexSdkHome(input.appId);
        if (sdkHome) baseEnv.HOME = sdkHome;
        const mcp = loadMcpServers(input.appId, baseEnv);
        if (mcp.errors.length) {
          send({ type: 'error', error: `codex-offical: ${mcp.errors.join('; ')}` });
          return;
        }
        const shelfMcp = await getShelfMcp();
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
          send({ type: 'error', error: `codex-offical: ${mapped.errors.join('; ')}` });
          return;
        }

        const client = createClient({
          codexPathOverride: resolveCodexPath(),
          ...mapped.codexOptions,
        });
        const resumeId = input.restoreContext?.lastSdkSessionId;
        const thread = resumeId
          ? client.resumeThread(resumeId, mapped.threadOptions)
          : client.startThread(mapped.threadOptions);
        const { events } = await thread.runStreamed(sdkInput.input, { signal: controller.signal });

        for await (const event of events) {
          if (event.type === 'thread.started' && resumeId && event.thread_id !== resumeId) {
            send({
              type: 'error',
              error: `codex-offical: resume thread mismatch (requested ${resumeId}, got ${event.thread_id})`,
            });
            return;
          }
          for (const message of translateCodexThreadEvent(event)) send(message);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          send({ type: 'error', error: `codex-offical: ${(err as Error)?.message ?? String(err)}` });
        }
      } finally {
        if (activeRun === runId) {
          activeRun = null;
          activeController = null;
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
      return buildCapabilities(customModels);
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

    configHome(appId): string | undefined {
      return codexConfigHome(appId);
    },

    async stop(): Promise<void> {
      activeController?.abort();
    },

    reconnect(): void {
      activeController?.abort();
    },

    dispose(): void {
      activeController?.abort();
      loginHandle?.cancel();
      loginHandle = null;
    },
  };
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
