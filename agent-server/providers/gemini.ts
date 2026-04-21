import { createEngine } from '../../src/main/agent/engine';
import { createToolExecutor } from '../../src/main/agent/tools/executor';
import { localExec } from '../tool-exec';
import type { ServerBackend, SendFn, QueryInput } from './types';
import type { PermissionCallback, PermissionResult, AgentEvent } from '../../src/main/agent/types';

// Static model catalogue — Gemini's OpenAI-compat endpoint doesn't advertise
// a /models list, so keep the same set local and remote know about.
const GEMINI_CONTEXT: Record<string, number> = {
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-pro':   1_048_576,
  'gemini-2.0-flash': 1_048_576,
};

export function createGeminiBackend(): ServerBackend {
  const pendingPermissions = new Map<string, (result: PermissionResult) => void>();
  let currentSend: SendFn | null = null;

  const canUseTool: PermissionCallback = async (toolUseId, toolName, input) => {
    currentSend?.({ type: 'permission_request', toolUseId, toolName, input });
    return new Promise<PermissionResult>((resolve) => {
      pendingPermissions.set(toolUseId, resolve);
    });
  };

  const processor = createEngine({
    apiKey: process.env.GEMINI_API_KEY ?? 'missing',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-2.5-flash',
    providerName: 'gemini',
    toolExecutor: createToolExecutor(localExec),
    getContextWindow: (model) => GEMINI_CONTEXT[model],
  });

  return {
    async query(input: QueryInput, send: SendFn) {
      currentSend = send;
      if (input.model) processor.setModel(input.model);
      if (input.effort) processor.setEffort(input.effort);

      if (!process.env.GEMINI_API_KEY) {
        send({ type: 'auth_required', provider: 'gemini' });
        send({ type: 'status', state: 'idle' });
        return;
      }

      try {
        for await (const event of processor.query(input.prompt, input.cwd, {
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

    async stop() {
      for (const resolve of pendingPermissions.values()) {
        resolve({ behavior: 'deny', message: 'Stopped by user' });
      }
      pendingPermissions.clear();
      await processor.stop();
    },

    dispose() { processor.dispose(); },

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
