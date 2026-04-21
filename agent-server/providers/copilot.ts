import { createEngine } from '../../src/main/agent/engine';
import { createToolExecutor } from '../../src/main/agent/tools/executor';
import { getEffortLevels } from '../../src/main/agent/tools/registry';
import type { ModelInfo } from '../../src/main/agent/engine/types';
import type { PermissionCallback, PermissionResult, AgentEvent, ProviderCapabilities } from '../../src/main/agent/types';
import { getCopilotSessionToken, isAuthenticated, COPILOT_DEFAULT_HEADERS } from './copilot-auth';
import { localExec } from '../tool-exec';
import type { ServerBackend, SendFn, QueryInput } from './types';

interface CopilotModelRaw {
  id: string;
  name?: string;
  capabilities?: {
    type?: string;
    limits?: { max_context_window_tokens?: number; max_prompt_tokens?: number };
    supports?: { vision?: boolean; streaming?: boolean; tool_calls?: boolean };
  };
  model_picker_enabled?: boolean;
}

async function fetchCopilotModels(session: { token: string; apiEndpoint: string }): Promise<CopilotModelRaw[]> {
  try {
    const res = await fetch(`${session.apiEndpoint}/models`, {
      headers: {
        'Authorization': `Bearer ${session.token}`,
        'Accept': 'application/json',
        ...COPILOT_DEFAULT_HEADERS,
      },
    });
    if (!res.ok) return [];
    const body = await res.json() as { data?: CopilotModelRaw[] };
    return body.data ?? [];
  } catch {
    return [];
  }
}

export function createCopilotBackend(): ServerBackend {
  const pendingPermissions = new Map<string, (result: PermissionResult) => void>();
  let currentSend: SendFn | null = null;
  const contextWindows = new Map<string, number>();

  const canUseTool: PermissionCallback = async (toolUseId, toolName, input) => {
    currentSend?.({ type: 'permission_request', toolUseId, toolName, input });
    return new Promise<PermissionResult>((resolve) => {
      pendingPermissions.set(toolUseId, resolve);
    });
  };

  const engine = createEngine({
    baseURL: 'https://api.githubcopilot.com',
    defaultModel: 'gpt-4o',
    providerName: 'copilot',
    defaultHeaders: COPILOT_DEFAULT_HEADERS,
    tokenProvider: async () => {
      const session = await getCopilotSessionToken();
      return { apiKey: session.token, baseURL: session.apiEndpoint };
    },
    toolExecutor: createToolExecutor(localExec),
    getContextWindow: (model) => contextWindows.get(model),
    async getModels(): Promise<ModelInfo[]> {
      try {
        const session = await getCopilotSessionToken();
        const raw = await fetchCopilotModels(session);
        const chat = raw.filter((m) => m.capabilities?.type !== 'embeddings' && m.model_picker_enabled !== false);
        contextWindows.clear();
        for (const m of chat) {
          const w = m.capabilities?.limits?.max_context_window_tokens;
          if (w) contextWindows.set(m.id, w);
        }
        return chat.map((m) => ({
          id: m.id,
          displayName: m.name ?? m.id,
          contextWindow: m.capabilities?.limits?.max_context_window_tokens ?? 0,
          vision: m.capabilities?.supports?.vision ?? false,
          effortLevels: getEffortLevels(m.id),
        }));
      } catch {
        return [];
      }
    },
    authMethod: {
      kind: 'oauth',
      instructions: [
        { label: 'Add Copilot scope to an existing gh login', command: 'gh auth refresh -h github.com -s copilot' },
        { label: 'First-time sign in with gh', command: 'gh auth login -s copilot' },
      ],
    },
    customCheckAuth: async () => isAuthenticated(),
  });

  return {
    async query(input: QueryInput, send: SendFn) {
      currentSend = send;
      if (input.model) engine.setModel(input.model);
      if (input.effort) engine.setEffort(input.effort);

      try {
        for await (const event of engine.query(input.prompt, input.cwd, {
          permissionMode: input.permissionMode,
          canUseTool,
          images: input.images,
        })) {
          translateEvent(event, send);
        }
      } catch (err: any) {
        if (err?.message === 'NO_AUTH') {
          send({ type: 'auth_required', provider: 'copilot' });
        } else {
          send({ type: 'error', error: err.message ?? 'Unknown error' });
        }
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
        type: 'message',
        msgType: p.type,
        content: p.content ?? '',
        toolName: p.toolName,
        toolInput: p.toolInput,
        toolUseId: p.toolUseId,
        parentToolUseId: p.parentToolUseId,
        sessionId: p.sessionId,
        costUsd: p.costUsd,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
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
