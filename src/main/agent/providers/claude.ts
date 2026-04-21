import type { AgentBackend, AgentEvent, AgentMessagePayload, AgentQueryOptions, ProviderCapabilities } from '../types';
import type { AuthMethod, ModelInfo, SlashCommand } from '../engine/types';
import type { Query, SDKMessage, Options, CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { log } from '@shared/logger';

let sdkQuery: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null;

async function loadSdk() {
  if (!sdkQuery) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    sdkQuery = sdk.query;
  }
  return sdkQuery;
}

let cachedBinaryPath: string | null | undefined;

// SDK 0.2.x ships the real Claude Code runtime as a platform-specific native
// binary in an optionalDependency (`@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude`).
// In packaged builds node_modules lives inside `app.asar` which is a file —
// child_process.spawn on a path containing `app.asar/...` fails with ENOTDIR.
// We opt the binary out of the archive via `asarUnpack` in package.json and
// resolve the unpacked path here so the SDK skips its own require.resolve.
function resolveClaudeBinaryPath(): string | null {
  if (cachedBinaryPath !== undefined) return cachedBinaryPath;

  const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const packages: string[] = process.platform === 'linux'
    ? [
        `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`,
        `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`,
      ]
    : [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`];

  const roots: string[] = [];
  if (app.isPackaged) {
    roots.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'));
  }
  roots.push(path.join(app.getAppPath(), 'node_modules'));

  for (const root of roots) {
    for (const pkg of packages) {
      const candidate = path.join(root, pkg, binName);
      if (fs.existsSync(candidate)) {
        cachedBinaryPath = candidate;
        return candidate;
      }
    }
  }
  log.error('claude-backend', `Claude native binary not found for ${process.platform}-${process.arch}`);
  cachedBinaryPath = null;
  return null;
}

function dataUrlToClaudeBlock(dataUrl: string): { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | null {
  const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!match) return null;
  if (match[2].length > 20 * 1024 * 1024) return null;
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

const CLAUDE_AUTH: AuthMethod = {
  kind: 'sdk-managed',
  instructions: [
    { label: 'Sign in to Claude via the CLI', command: 'claude login' },
  ],
};

export function createClaudeBackend(): AgentBackend {
  let activeQuery: Query | null = null;
  let abortController: AbortController | null = null;
  let currentModel: string | null = null;
  let currentEffort: string | null = null;

  // Lazy cache for models + slash commands. Both come from a single Claude SDK
  // plan-mode query so we pay the init once, then getModels / getSlashCommands
  // just return from the cache.
  const cache: { models?: ModelInfo[]; commands?: SlashCommand[] } = {};
  let initPromise: Promise<void> | null = null;

  function ensureInit(cwd: string): Promise<void> {
    if (cache.models && cache.commands) return Promise.resolve();
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const queryFn = await loadSdk();
      const warmupAbort = new AbortController();
      const binaryPath = resolveClaudeBinaryPath();
      const generator = queryFn({
        prompt: ' ',
        options: {
          cwd,
          permissionMode: 'plan',
          abortController: warmupAbort,
          ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
        },
      });
      try {
        for await (const msg of generator) {
          if (msg.type === 'system' && msg.subtype === 'init') {
            const [models, commands] = await Promise.all([
              generator.supportedModels().catch(() => []),
              generator.supportedCommands().catch(() => []),
            ]);
            cache.models = models.map((m) => ({
              id: m.value,
              displayName: m.displayName,
              contextWindow: 200_000, // SDK doesn't expose; hard-code Claude 3+ default
              vision: true,
            }));
            cache.commands = commands.map((c) => ({ name: c.name, description: c.description }));
            log.info('claude-backend', `Init done: ${models.length} models, ${commands.length} commands`);
            warmupAbort.abort();
            break;
          }
        }
      } catch (err: any) {
        // warmupAbort.abort() above is intentional; AbortError is expected.
        // Anything else (e.g. spawn ENOTDIR) we want visible and retriable.
        if (err?.name !== 'AbortError') {
          log.error('claude-backend', 'ensureInit failed:', err?.message ?? String(err));
          initPromise = null;
          throw err;
        }
      }
    })();
    return initPromise;
  }

  return {
    async checkAuth() {
      // Claude SDK manages auth. We have no good way to probe without spawning
      // a query; assume authenticated and let the first real query surface any
      // errors via its error stream.
      return true;
    },

    async getModels(cwd?: string): Promise<ModelInfo[]> {
      await ensureInit(cwd ?? process.cwd());
      return cache.models ?? [];
    },

    async getSlashCommands(): Promise<SlashCommand[]> {
      await ensureInit(process.cwd());
      return cache.commands ?? [];
    },

    getPermissionModes(): string[] {
      return ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
    },

    getEffortLevels(): string[] {
      return ['low', 'medium', 'high', 'xhigh', 'max'];
    },

    getAuthMethod(): AuthMethod {
      return CLAUDE_AUTH;
    },


    async *query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent> {
      const queryStart = Date.now();
      log.debug('claude-backend', `query.start cwd=${cwd} promptLen=${prompt.length} resume=${opts?.resume ?? '-'} permMode=${opts?.permissionMode ?? 'default'} model=${currentModel ?? '-'} effort=${currentEffort ?? '-'} images=${opts?.images?.length ?? 0}`);
      const queryFn = await loadSdk();
      abortController = new AbortController();

      const binaryPath = resolveClaudeBinaryPath();
      const options: Options = {
        abortController,
        cwd,
        tools: { type: 'preset', preset: 'claude_code' },
        thinking: { type: 'adaptive' },
        includePartialMessages: true,
        permissionMode: (opts?.permissionMode as Options['permissionMode']) ?? 'default',
        ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
      };

      if (currentModel) {
        (options as any).model = currentModel;
      }
      if (currentEffort) {
        (options as any).effort = currentEffort;
      }

      if (opts?.resume) {
        options.resume = opts.resume;
      }

      if (opts?.canUseTool) {
        const userCallback = opts.canUseTool;
        options.canUseTool = (async (toolName, input, canUseOpts) => {
          log.debug('claude-backend', `canUseTool.request tool=${toolName} toolUseId=${canUseOpts.toolUseID}`);
          const result = await userCallback(canUseOpts.toolUseID, toolName, input);
          log.debug('claude-backend', `canUseTool.resolved tool=${toolName} toolUseId=${canUseOpts.toolUseID} decision=${result.behavior}`);
          if (result.behavior === 'allow') {
            return { behavior: 'allow' as const };
          }
          return { behavior: 'deny' as const, message: result.message ?? 'Denied by user' };
        }) as CanUseTool;
      }

      // When images accompany the turn, Claude SDK expects a user message with
      // content blocks instead of a plain prompt string — pass an async
      // generator yielding a single composed message.
      let promptArg: Parameters<typeof queryFn>[0]['prompt'] = prompt;
      const imageBlocks = (opts?.images ?? [])
        .map(dataUrlToClaudeBlock)
        .filter((b): b is NonNullable<typeof b> => b !== null);
      if (imageBlocks.length > 0) {
        const contentBlocks: any[] = [
          ...imageBlocks,
          ...(prompt ? [{ type: 'text', text: prompt }] : []),
        ];
        async function* single() {
          yield { type: 'user' as const, message: { role: 'user' as const, content: contentBlocks } } as any;
        }
        promptArg = single() as any;
      }

      activeQuery = queryFn({ prompt: promptArg, options });

      let msgCount = 0;
      try {
        for await (const msg of activeQuery) {
          msgCount++;
          const events = processMessage(msg, currentModel);
          for (const event of events) {
            yield event;
          }
        }
        log.debug('claude-backend', `query.end duration=${Date.now() - queryStart}ms messages=${msgCount}`);
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          log.error('claude-backend', `Query error after ${Date.now() - queryStart}ms (messages=${msgCount}): ${err.message}`);
          yield { type: 'error', error: err.message ?? 'Unknown error' };
        } else {
          log.debug('claude-backend', `query.aborted duration=${Date.now() - queryStart}ms messages=${msgCount}`);
        }
      } finally {
        activeQuery = null;
        abortController = null;
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

    setModel(model: string) {
      currentModel = model || null;
    },

    setEffort(effort: string) {
      currentEffort = effort || null;
    },
  };
}


// Per-session stream delta accumulators — flushed on content_block_stop so a
// long thinking/text stream produces one aggregate log instead of hundreds.
const streamAccum = new Map<string, { type: string; chars: number }>();

function processMessage(msg: SDKMessage, currentModel: string | null): AgentEvent[] {
  const events: AgentEvent[] = [];

  // Top-level trace so every SDK message type is visible in the log, not just
  // `assistant`. Without this, streams that never emit a full assistant block
  // look like dead silence from claude-backend's side.
  if (msg.type !== 'stream_event') {
    log.debug('claude-backend', `msg.type=${msg.type}${(msg as any).subtype ? ` subtype=${(msg as any).subtype}` : ''} session=${(msg as any).session_id ?? '-'}`);
  }

  switch (msg.type) {
    case 'assistant': {
      const content = msg.message.content;
      const blockSummary = content.map((b: any) => `${b.type}${b.type === 'thinking' ? `(${(b.thinking ?? '').length}c)` : b.type === 'text' ? `(${(b.text ?? '').length}c)` : ''}`).join(',');
      log.debug('claude-backend', `assistant blocks=[${blockSummary}] session=${msg.session_id}`);
      for (const block of content) {
        if (block.type === 'thinking') {
          events.push({
            type: 'message',
            payload: { type: 'thinking', content: block.thinking, sessionId: msg.session_id },
          });
        } else if (block.type === 'text') {
          events.push({
            type: 'message',
            payload: { type: 'text', content: block.text, sessionId: msg.session_id },
          });
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'message',
            payload: {
              type: 'tool_use',
              content: '',
              toolName: block.name,
              toolInput: block.input as Record<string, unknown>,
              toolUseId: block.id,
              parentToolUseId: msg.parent_tool_use_id ?? undefined,
              sessionId: msg.session_id,
            },
          });
        }
      }

      if (msg.message.usage) {
        events.push({
          type: 'status',
          payload: {
            state: 'streaming',
            model: msg.message.model,
            inputTokens: msg.message.usage.input_tokens,
            outputTokens: msg.message.usage.output_tokens,
            sessionId: msg.session_id,
          },
        });
      }
      break;
    }

    case 'stream_event': {
      // SDK partial — used to stream text/thinking deltas as the assistant
      // model produces them. includePartialMessages=true in query() enables
      // these; without handling them here, replies appeared all-at-once
      // because only the final `assistant` message was processed.
      const event: any = (msg as any).event;
      const sessionId: string = (msg as any).session_id ?? '-';
      const eventType = event?.type;

      if (eventType === 'content_block_start') {
        const blockType = event.content_block?.type ?? 'unknown';
        const key = `${sessionId}#${event.index ?? 0}`;
        streamAccum.set(key, { type: blockType, chars: 0 });
        log.debug('claude-backend', `stream.start idx=${event.index} type=${blockType} session=${sessionId}`);
      } else if (eventType === 'content_block_delta' && event.delta) {
        const delta = event.delta;
        const key = `${sessionId}#${event.index ?? 0}`;
        const acc = streamAccum.get(key);
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
          if (acc) acc.chars += delta.text.length;
          events.push({ type: 'stream', payload: { type: 'text', content: delta.text } });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
          if (acc) acc.chars += delta.thinking.length;
          events.push({ type: 'stream', payload: { type: 'thinking', content: delta.thinking } });
        } else {
          // Unknown delta — log once so we notice new SDK payloads.
          log.debug('claude-backend', `stream.delta.unhandled type=${delta.type} session=${sessionId}`);
        }
      } else if (eventType === 'content_block_stop') {
        const key = `${sessionId}#${event.index ?? 0}`;
        const acc = streamAccum.get(key);
        log.debug('claude-backend', `stream.stop idx=${event.index} type=${acc?.type ?? '?'} chars=${acc?.chars ?? 0} session=${sessionId}`);
        streamAccum.delete(key);
      } else if (eventType && eventType !== 'message_start' && eventType !== 'message_delta' && eventType !== 'message_stop' && eventType !== 'ping') {
        // Surface unexpected SDK stream event types so we know what's flowing.
        log.debug('claude-backend', `stream.event type=${eventType} session=${sessionId}`);
      }
      break;
    }

    case 'user': {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if ((block as any).type === 'tool_result') {
            events.push({
              type: 'message',
              payload: {
                type: 'tool_result',
                content: typeof (block as any).content === 'string'
                  ? (block as any).content
                  : JSON.stringify((block as any).content ?? ''),
                toolUseId: (block as any).tool_use_id,
                sessionId: msg.session_id,
              },
            });
          }
        }
      }
      break;
    }

    case 'result': {
      const resultText = msg.subtype === 'success' ? msg.result : (msg.errors?.join('\n') ?? 'Error');
      const cost = msg.subtype === 'success' ? msg.total_cost_usd : undefined;
      const usage = msg.subtype === 'success' ? msg.usage : undefined;
      const numTurns = msg.subtype === 'success' ? msg.num_turns : undefined;

      // Context % shown in UI must reflect the CURRENT turn's input footprint,
      // not the session total. `modelUsage` is cumulative (note its `costUSD`
      // field — costs only ever grow), so summing its token counters against
      // `contextWindow` made a long session display 130%+ while Claude's own
      // /context correctly showed ~45%. `msg.usage` is the per-turn Anthropic
      // API usage; that's the right numerator. We still need `modelUsage` for
      // the `contextWindow` denominator (the only place the SDK exposes it).
      let contextUsedTokens: number | undefined;
      let contextWindow: number | undefined;
      if (msg.subtype === 'success') {
        const u = msg.usage as any;
        if (u) {
          contextUsedTokens = (u.input_tokens ?? 0)
            + (u.cache_read_input_tokens ?? 0)
            + (u.cache_creation_input_tokens ?? 0);
        }
        if (msg.modelUsage) {
          const preferred = currentModel && msg.modelUsage[currentModel]
            ? msg.modelUsage[currentModel]
            : Object.values(msg.modelUsage)[0];
          contextWindow = preferred?.contextWindow;
        }
      }
      const payload: AgentMessagePayload = {
        type: 'result',
        content: resultText,
        sessionId: msg.session_id,
        costUsd: cost,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      };
      events.push({ type: 'message', payload });
      events.push({
        type: 'status',
        payload: {
          state: 'idle',
          costUsd: cost,
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          numTurns,
          sessionId: msg.session_id,
          contextUsedTokens,
          contextWindow,
        },
      });
      break;
    }

    case 'rate_limit_event': {
      events.push({
        type: 'status',
        payload: {
          state: 'streaming',
          sessionId: msg.session_id,
          rateLimit: {
            rateLimitType: msg.rate_limit_info.rateLimitType,
            status: msg.rate_limit_info.status,
            utilization: msg.rate_limit_info.utilization,
            resetsAt: msg.rate_limit_info.resetsAt,
          },
        },
      });
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        events.push({
          type: 'status',
          payload: { state: 'streaming', model: msg.model, sessionId: msg.session_id },
        });
      }
      break;
    }

    default:
      break;
  }

  return events;
}
