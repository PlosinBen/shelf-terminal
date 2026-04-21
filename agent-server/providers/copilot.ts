import { createEngine } from '../../src/main/agent/engine';
import { createToolExecutor } from '../../src/main/agent/tools/executor';
import { getCopilotSessionToken, COPILOT_DEFAULT_HEADERS } from './copilot-auth';
import { localExec } from '../tool-exec';
import type { ServerBackend, SendFn, QueryInput } from './types';
import type { PermissionCallback, PermissionResult, AgentEvent } from '../../src/main/agent/types';

export function createCopilotBackend(): ServerBackend {
  const pendingPermissions = new Map<string, (result: PermissionResult) => void>();
  let currentSend: SendFn | null = null;

  const canUseTool: PermissionCallback = async (toolUseId, toolName, input) => {
    currentSend?.({ type: 'permission_request', toolUseId, toolName, input });
    return new Promise<PermissionResult>((resolve) => {
      pendingPermissions.set(toolUseId, resolve);
    });
  };

  const processor = createEngine({
    baseURL: 'https://api.githubcopilot.com',
    defaultModel: 'gpt-4o',
    providerName: 'copilot',
    defaultHeaders: COPILOT_DEFAULT_HEADERS,
    tokenProvider: async () => {
      const session = await getCopilotSessionToken();
      return { apiKey: session.token, baseURL: session.apiEndpoint };
    },
    toolExecutor: createToolExecutor(localExec),
  });

  return {
    async query(input: QueryInput, send: SendFn) {
      currentSend = send;
      if (input.model) processor.setModel(input.model);
      if (input.effort) processor.setEffort(input.effort);

      try {
        for await (const event of processor.query(input.prompt, input.cwd, {
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
        // Reject any still-pending permission requests so callbacks don't leak.
        for (const resolve of pendingPermissions.values()) {
          resolve({ behavior: 'deny', message: 'Session ended' });
        }
        pendingPermissions.clear();
        send({ type: 'status', state: 'idle' });
      }
    },

    async stop() {
      for (const resolve of pendingPermissions.values()) {
        resolve({ behavior: 'deny', message: 'Stopped by user' });
      }
      pendingPermissions.clear();
      await processor.stop();
    },

    dispose() {
      processor.dispose();
    },

    // Non-standard hook so index.ts can route incoming resolve_permission
    // messages to the right backend instance.
    resolvePermission(toolUseId: string, allow: boolean, message?: string) {
      const resolve = pendingPermissions.get(toolUseId);
      if (resolve) {
        pendingPermissions.delete(toolUseId);
        resolve(allow ? { behavior: 'allow' } : { behavior: 'deny', message: message ?? 'Denied' });
      }
    },
  } as ServerBackend & { resolvePermission(id: string, allow: boolean, message?: string): void };
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
