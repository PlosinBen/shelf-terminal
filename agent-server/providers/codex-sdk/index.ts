import { CODEX_OFFICAL_PROVIDER } from '@shared/agent-providers';
import * as path from 'node:path';
import type { ProviderModel } from '@shared/types';
import { codexConfigHome, codexEnv } from '../codex-shared/runtime';
import { driveDeviceCodeLogin, spawnCodexAppServerRpc, type LoginHandle, type LoginRpc } from '../codex-shared/app-server-login';
import { pickEffortLevels, pickPermissionModes, type ProviderCapabilities, type SendFn, type ServerBackend } from '../types';
import { CODEX_SDK_EFFORT_LEVELS } from './config';

export interface CodexOfficialDeps {
  spawnLoginRpc?: (env: NodeJS.ProcessEnv) => { rpc: LoginRpc };
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
  const spawnLoginRpc = deps.spawnLoginRpc ?? ((env: NodeJS.ProcessEnv) => spawnCodexAppServerRpc(env));

  function buildCapabilities(customModels: ProviderModel[] = []): ProviderCapabilities {
    return {
      models: customModels.map((model) => ({ value: model.id, displayName: model.id })),
      permissionModes: pickPermissionModes(['default', 'plan', 'bypassPermissions']),
      effortLevels: pickEffortLevels([...CODEX_SDK_EFFORT_LEVELS]),
      slashCommands: [],
      ...(currentModel ? { currentModel } : {}),
      ...(currentEffort ? { currentEffort } : {}),
      ...(currentPermissionMode ? { currentPermissionMode } : {}),
    };
  }

  return {
    async query(_input, send): Promise<void> {
      send({
        type: 'error',
        error: 'codex-offical: official SDK provider lifecycle is not implemented yet; this test provider is registered for Phase 1 isolation only.',
      });
      send({ type: 'status', state: 'idle' });
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

    async stop(): Promise<void> {},

    reconnect(): void {},

    dispose(): void {
      loginHandle?.cancel();
      loginHandle = null;
    },
  };
}
