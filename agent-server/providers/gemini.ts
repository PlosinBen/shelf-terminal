import { createEngine } from '../../src/main/agent/engine';
import { createToolExecutor } from '../../src/main/agent/tools/executor';
import type { ModelInfo } from '../../src/main/agent/engine/types';
import type { PermissionCallback, PermissionResult, AgentEvent, ProviderCapabilities } from '../../src/main/agent/types';
import { localExec } from '../tool-exec';
import type { ServerBackend, SendFn, QueryInput } from './types';

const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', contextWindow: 1_048_576, vision: true },
  { id: 'gemini-2.5-pro',   displayName: 'Gemini 2.5 Pro',   contextWindow: 1_048_576, vision: true },
  { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', contextWindow: 1_048_576, vision: true },
];

export function createGeminiBackend(): ServerBackend {
  const pendingPermissions = new Map<string, (result: PermissionResult) => void>();
  let currentSend: SendFn | null = null;
  const contextWindows = new Map(GEMINI_MODELS.map((m) => [m.id, m.contextWindow]));

  const canUseTool: PermissionCallback = async (toolUseId, toolName, input) => {
    currentSend?.({ type: 'permission_request', toolUseId, toolName, input });
    return new Promise<PermissionResult>((resolve) => {
      pendingPermissions.set(toolUseId, resolve);
    });
  };

  const engine = createEngine({
    apiKey: process.env.GEMINI_API_KEY ?? 'missing',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: GEMINI_MODELS[0].id,
    providerName: 'gemini',
    toolExecutor: createToolExecutor(localExec),
    getContextWindow: (model) => contextWindows.get(model),
    getModels: async () => GEMINI_MODELS,
    authMethod: {
      kind: 'api-key',
      envVar: 'GEMINI_API_KEY',
      setupUrl: 'https://aistudio.google.com/apikey',
      placeholder: 'AIza...',
    },
    customCheckAuth: async () => !!process.env.GEMINI_API_KEY,
  });

  return {
    async query(input: QueryInput, send: SendFn) {
      currentSend = send;
      if (input.model) engine.setModel(input.model);
      if (input.effort) engine.setEffort(input.effort);

      if (!process.env.GEMINI_API_KEY) {
        send({ type: 'auth_required', provider: 'gemini' });
        send({ type: 'status', state: 'idle' });
        return;
      }

      try {
        for await (const event of engine.query(input.prompt, input.cwd, {
          permissionMode: input.permissionMode,
          canUseTool,
          images: input.images,
        })) {
          translateEvent(event, send);
        }
      } catch (err: any) {
        send({ type: 'error', error: err.message ?? 'Unknown error' });
      } finally {
        for (const resolve of pendingPermissions.values()) {
          resolve({ behavior: 'deny', message: 'Session ended' });
        }
        pendingPermissions.clear();
        send({ type: 'status', state: 'idle' });
      }
    },

    async gatherCapabilities(_cwd: string): Promise<ProviderCapabilities> {
      const [models, slashCommands] = await Promise.all([
        engine.getModels(),
        engine.getSlashCommands(),
      ]);
      return {
        models: models.map((m) => ({
          value: m.id,
          displayName: m.displayName,
          effortLevels: m.effortLevels,
          vision: m.vision,
        })),
        permissionModes: engine.getPermissionModes(),
        effortLevels: engine.getEffortLevels(),
        slashCommands,
        authMethod: engine.getAuthMethod(),
      };
    },

    async stop() {
      for (const resolve of pendingPermissions.values()) {
        resolve({ behavior: 'deny', message: 'Stopped by user' });
      }
      pendingPermissions.clear();
      await engine.stop();
    },

    dispose() { engine.dispose(); },

    resolvePermission(toolUseId: string, allow: boolean, message?: string) {
      const resolve = pendingPermissions.get(toolUseId);
      if (resolve) {
        pendingPermissions.delete(toolUseId);
        resolve(allow ? { behavior: 'allow' } : { behavior: 'deny', message: message ?? 'Denied' });
      }
    },
  };
}

function translateEvent(event: AgentEvent, send: SendFn) {
  switch (event.type) {
    case 'message': {
      const p = event.payload;
      send({
        type: 'message', msgType: p.type, content: p.content ?? '',
        toolName: p.toolName, toolInput: p.toolInput, toolUseId: p.toolUseId,
        parentToolUseId: p.parentToolUseId, sessionId: p.sessionId,
        costUsd: p.costUsd, inputTokens: p.inputTokens, outputTokens: p.outputTokens,
      });
      break;
    }
    case 'stream':
      send({ type: 'stream', streamType: event.payload.type, content: event.payload.content });
      break;
    case 'status':
      send({ type: 'status', ...event.payload });
      break;
    case 'auth_required':
      send({ type: 'auth_required', provider: event.provider });
      break;
    case 'error':
      send({ type: 'error', error: event.error });
      break;
  }
}
