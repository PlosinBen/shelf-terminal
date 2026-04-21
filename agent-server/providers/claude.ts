import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import * as path from 'path';
import type { QueryInput, SendFn, ServerBackend } from './types';
import type { ProviderCapabilities } from '../../src/main/agent/types';

const CLAUDE_AUTH_METHOD = {
  kind: 'sdk-managed' as const,
  instructions: [{ label: 'Sign in to Claude via the CLI', command: 'claude login' }],
};

export function createClaudeBackend(): ServerBackend {
  let activeQuery: Query | null = null;
  let abortController: AbortController | null = null;
  const cache: { models?: any[]; commands?: any[] } = {};
  let initPromise: Promise<void> | null = null;

  function ensureInit(cwd: string): Promise<void> {
    if (cache.models && cache.commands) return Promise.resolve();
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const warmupAbort = new AbortController();
      const generator = sdkQuery({
        prompt: ' ',
        options: {
          cwd,
          permissionMode: 'plan',
          abortController: warmupAbort,
          pathToClaudeCodeExecutable: path.join(__dirname, 'cli.js'),
        },
      });
      try {
        for await (const msg of generator) {
          if (msg.type === 'system' && msg.subtype === 'init') {
            const [models, commands] = await Promise.all([
              generator.supportedModels().catch(() => []),
              generator.supportedCommands().catch(() => []),
            ]);
            cache.models = models;
            cache.commands = commands;
            warmupAbort.abort();
            break;
          }
        }
      } catch { /* abort throws, expected */ }
    })();
    return initPromise;
  }

  return {
    async gatherCapabilities(cwd: string): Promise<ProviderCapabilities> {
      await ensureInit(cwd);
      return {
        models: (cache.models ?? []).map((m) => ({ value: m.value, displayName: m.displayName, vision: true })),
        permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
        effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        slashCommands: (cache.commands ?? []).map((c) => ({ name: c.name, description: c.description })),
        authMethod: CLAUDE_AUTH_METHOD,
      };
    },

    async query(input: QueryInput, send: SendFn) {
      abortController = new AbortController();
      const cliPath = path.join(__dirname, 'cli.js');

      const options: Options = {
        abortController,
        cwd: input.cwd,
        pathToClaudeCodeExecutable: cliPath,
        tools: { type: 'preset', preset: 'claude_code' },
        thinking: { type: 'adaptive' },
        includePartialMessages: true,
        permissionMode: (input.permissionMode as Options['permissionMode']) ?? 'default',
      };

      if (input.resume) options.resume = input.resume;
      if (input.model) (options as any).model = input.model;
      if (input.effort) (options as any).effort = input.effort;

      // Images attached: pass as content blocks via async generator (matches
      // the pattern used in src/main/agent/providers/claude.ts).
      let promptArg: Parameters<typeof sdkQuery>[0]['prompt'] = input.prompt;
      const imageBlocks = (input.images ?? [])
        .map(dataUrlToImageBlock)
        .filter((b): b is NonNullable<typeof b> => b !== null);
      if (imageBlocks.length > 0) {
        const content: any[] = [
          ...imageBlocks,
          ...(input.prompt ? [{ type: 'text', text: input.prompt }] : []),
        ];
        async function* single() {
          yield { type: 'user' as const, message: { role: 'user' as const, content } } as any;
        }
        promptArg = single() as any;
      }

      activeQuery = sdkQuery({ prompt: promptArg, options });

      try {
        for await (const sdkMsg of activeQuery) {
          processMessage(sdkMsg, send);
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          send({ type: 'error', error: err.message ?? 'Unknown error' });
        }
      } finally {
        activeQuery = null;
        abortController = null;
        send({ type: 'status', state: 'idle' });
      }
    },

    async stop() {
      if (activeQuery) {
        try {
          await activeQuery.interrupt();
        } catch {
          abortController?.abort();
        }
      }
    },

    dispose() {
      abortController?.abort();
      activeQuery = null;
      abortController = null;
    },
  };
}

function dataUrlToImageBlock(dataUrl: string): { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | null {
  const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!match) return null;
  if (match[2].length > 20 * 1024 * 1024) return null;
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

function processMessage(msg: SDKMessage, send: SendFn) {
  switch (msg.type) {
    case 'assistant': {
      for (const block of msg.message.content) {
        if (block.type === 'thinking') {
          send({ type: 'message', msgType: 'thinking', content: block.thinking, sessionId: msg.session_id });
        } else if (block.type === 'text') {
          send({ type: 'message', msgType: 'text', content: block.text, sessionId: msg.session_id });
        } else if (block.type === 'tool_use') {
          send({
            type: 'message', msgType: 'tool_use', content: '',
            toolName: block.name, toolInput: block.input, toolUseId: block.id,
            parentToolUseId: msg.parent_tool_use_id ?? undefined, sessionId: msg.session_id,
          });
        }
      }
      if (msg.message.usage) {
        send({
          type: 'status', state: 'streaming', model: msg.message.model,
          inputTokens: msg.message.usage.input_tokens, outputTokens: msg.message.usage.output_tokens,
          sessionId: msg.session_id,
        });
      }
      break;
    }

    case 'user': {
      if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if ((block as any).type === 'tool_result') {
            send({
              type: 'message', msgType: 'tool_result',
              content: typeof (block as any).content === 'string' ? (block as any).content : JSON.stringify((block as any).content ?? ''),
              toolUseId: (block as any).tool_use_id, sessionId: msg.session_id,
            });
          }
        }
      }
      break;
    }

    case 'result': {
      const isSuccess = msg.subtype === 'success';
      send({
        type: 'message', msgType: 'result',
        content: isSuccess ? msg.result : (msg.errors?.join('\n') ?? 'Error'),
        sessionId: msg.session_id,
        costUsd: isSuccess ? msg.total_cost_usd : undefined,
        inputTokens: isSuccess ? msg.usage?.input_tokens : undefined,
        outputTokens: isSuccess ? msg.usage?.output_tokens : undefined,
      });
      send({
        type: 'status', state: 'idle',
        costUsd: isSuccess ? msg.total_cost_usd : undefined,
        inputTokens: isSuccess ? msg.usage?.input_tokens : undefined,
        outputTokens: isSuccess ? msg.usage?.output_tokens : undefined,
        numTurns: isSuccess ? msg.num_turns : undefined,
        sessionId: msg.session_id,
      });
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        send({ type: 'status', state: 'streaming', model: msg.model, sessionId: msg.session_id });
      }
      break;
    }
  }
}
