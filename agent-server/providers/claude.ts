import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query, Options, SDKMessage, CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import type { QueryInput, SendFn, ServerBackend, ProviderCapabilities, SlashResult, StatusSegment } from './types';
import { severityFromUtilization, formatResetCountdown, pickPermissionModes, pickEffortLevels } from './types';
import type { ProviderModel } from '../../src/shared/types';

// Claude SDK's `supportedCommands()` only returns user-installed skills, not
// built-ins. Append these so the autocomplete menu lists them; submission still
// passes through to the SDK, which handles them natively.
const CLAUDE_BUILTIN_COMMANDS = [
  { name: 'model', description: 'Pick or switch the current model' },
  { name: 'clear', description: 'Reset the conversation context' },
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'help', description: 'List available slash commands' },
];

const RATE_LIMIT_LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d-opus',
  seven_day_sonnet: '7d-sonnet',
  overage: 'overage',
};

type PermissionResult =
  | { behavior: 'allow'; scope?: 'once' | 'session' }
  | { behavior: 'deny'; message?: string };

const CLAUDE_AUTH_METHOD = {
  kind: 'sdk-managed' as const,
  instructions: [{ label: 'Sign in to Claude via the CLI', command: 'claude login' }],
};

function resolveClaudeBinary(): string | undefined {
  const platform = process.platform;
  const arch = process.arch;
  const pkgName = `claude-agent-sdk-${platform}-${arch}`;

  const candidates = [
    // Development: node_modules relative to project root
    resolve(__dirname, '..', 'node_modules', '@anthropic-ai', pkgName, 'claude'),
    // Development: two levels up (if __dirname is dist/agent-server/<version>)
    resolve(__dirname, '..', '..', '..', 'node_modules', '@anthropic-ai', pkgName, 'claude'),
    // Packaged: unpacked from asar
    resolve(__dirname, '..', '..', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', pkgName, 'claude'),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function createClaudeBackend(): ServerBackend {
  let activeQuery: Query | null = null;
  let abortController: AbortController | null = null;
  const cache: { models?: any[]; commands?: any[] } = {};
  let initPromise: Promise<void> | null = null;
  let lastSessionId: string | null = null;

  const pendingPermissions = new Map<string, (result: PermissionResult) => void>();
  let currentSend: SendFn | null = null;

  const canUseTool: CanUseTool = (async (toolName, input, canUseOpts) => {
    const toolUseId = (canUseOpts as any)?.toolUseID ?? `sdk-${Date.now()}`;
    currentSend?.({ type: 'permission_request', toolUseId, toolName, input });
    const result = await new Promise<PermissionResult>((resolve) => {
      pendingPermissions.set(toolUseId, resolve);
    });
    if (result.behavior === 'allow') {
      const allow: any = { behavior: 'allow' as const, updatedInput: input };
      if (result.scope === 'session') {
        // SDK self-records the rule; future invocations of the same tool skip canUseTool entirely.
        allow.updatedPermissions = [{
          type: 'addRules',
          destination: 'session',
          behavior: 'allow',
          rules: [{ toolName }],
        }];
      }
      return allow;
    }
    return { behavior: 'deny' as const, message: result.message ?? 'Denied by user' };
  }) as CanUseTool;

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
          pathToClaudeCodeExecutable: resolveClaudeBinary(),
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
    async gatherCapabilities(cwd: string, _sessionId?: string, customModels?: ProviderModel[]): Promise<ProviderCapabilities> {
      await ensureInit(cwd);
      return {
        models: mergeClaudeModels(cache.models ?? [], customModels),
        permissionModes: pickPermissionModes(['default', 'acceptEdits', 'bypassPermissions', 'plan']),
        effortLevels: pickEffortLevels(['low', 'medium', 'high', 'xhigh', 'max']),
        slashCommands: (() => {
          const userCmds = (cache.commands ?? []).map((c: any) => ({ name: c.name, description: c.description }));
          const userNames = new Set(userCmds.map((c: any) => c.name));
          const builtins = CLAUDE_BUILTIN_COMMANDS.filter((b) => !userNames.has(b.name));
          return [...builtins, ...userCmds];
        })(),
        authMethod: CLAUDE_AUTH_METHOD,
      };
    },

    async query(input: QueryInput, send: SendFn) {
      currentSend = send;
      abortController = new AbortController();
      const mode = (input.permissionMode as Options['permissionMode']) ?? 'default';
      const isBypass = mode === 'bypassPermissions';
      // DIY bypass: SDK stays at 'default' and our canUseTool short-circuits to allow.
      // Avoids SDK's `allowDangerouslySkipPermissions` flag and keeps plan/acceptEdits
      // SDK-native (those have non-trivial built-in semantics worth keeping).
      const effectiveCanUseTool: CanUseTool = isBypass
        ? ((async (_n, toolInput) => ({ behavior: 'allow' as const, updatedInput: toolInput })) as CanUseTool)
        : canUseTool;
      const options: Options = {
        abortController,
        cwd: input.cwd,
        pathToClaudeCodeExecutable: undefined,
        tools: { type: 'preset', preset: 'claude_code' },
        thinking: { type: 'adaptive' },
        includePartialMessages: true,
        permissionMode: isBypass ? 'default' : mode,
        canUseTool: effectiveCanUseTool,
      };

      const resumeId = input.resume ?? lastSessionId;
      if (resumeId) options.resume = resumeId;
      if (input.model) (options as any).model = input.model;
      if (input.effort) (options as any).effort = input.effort;

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
          if ('session_id' in sdkMsg && sdkMsg.session_id) {
            lastSessionId = sdkMsg.session_id as string;
          }
          processMessage(sdkMsg, send);
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          send({ type: 'error', error: err.message ?? 'Unknown error' });
        }
      } finally {
        for (const resolve of pendingPermissions.values()) {
          resolve({ behavior: 'deny', message: 'Session ended' });
        }
        pendingPermissions.clear();
        activeQuery = null;
        abortController = null;
        send({ type: 'status', state: 'idle' });
      }
    },

    async stop() {
      for (const resolve of pendingPermissions.values()) {
        resolve({ behavior: 'deny', message: 'Stopped by user' });
      }
      pendingPermissions.clear();
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

    resolvePermission(toolUseId: string, allow: boolean, message?: string, scope?: 'once' | 'session') {
      const resolve = pendingPermissions.get(toolUseId);
      if (resolve) {
        pendingPermissions.delete(toolUseId);
        resolve(allow ? { behavior: 'allow', scope } : { behavior: 'deny', message: message ?? 'Denied' });
      }
    },

    async handleSlashCommand(cmd: string, _args: string): Promise<SlashResult> {
      // Claude SDK handles all slash commands natively (compact, clear, model, etc.)
      // Just send the original input as a regular message — SDK intercepts.
      // We piggyback to clear the sticky plan panel when context is reset.
      if (cmd === 'clear') {
        currentSend?.({ type: 'message', msgType: 'plan_update', content: '' });
      }
      return { type: 'pass-through' };
    },
  };
}

export function mergeClaudeModels(
  sdkModels: { value: string; displayName: string }[],
  customs?: ProviderModel[],
): { value: string; displayName: string; vision: boolean }[] {
  const result: { value: string; displayName: string; vision: boolean }[] = sdkModels.map((m) => ({
    value: m.value,
    displayName: m.displayName,
    vision: true,
  }));
  if (!customs || customs.length === 0) return result;
  const indexById = new Map(result.map((m, i) => [m.value, i]));
  for (const c of customs) {
    const entry = { value: c.id, displayName: c.id, vision: true };
    const existing = indexById.get(c.id);
    if (existing != null) {
      result[existing] = entry;
    } else {
      indexById.set(c.id, result.length);
      result.push(entry);
    }
  }
  return result;
}

function dataUrlToImageBlock(dataUrl: string): { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | null {
  const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!match) return null;
  if (match[2].length > 20 * 1024 * 1024) return null;
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

// Per-turn usage cache for context %. result.usage is cumulative across the
// agent loop (grows with each tool call within a turn), so dividing by
// contextWindow gives nonsense (>100% on long sessions). The right numerator
// is the LAST top-level assistant message's per-turn usage.
let lastTurnUsage: { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null = null;
let lastTurnModel: string | null = null;

function processMessage(msg: SDKMessage, send: SendFn) {
  switch (msg.type) {
    case 'assistant': {
      for (const block of msg.message.content) {
        if (block.type === 'thinking') {
          // With includePartialMessages: true, the SDK sometimes leaves the
          // assembled thinking block empty (content already streamed via
          // stream_event deltas). Skip the empty message — the renderer's
          // streamThinking accumulator will be flushed by its idle handler
          // when the turn ends. Sending empty content here would clobber
          // the accumulator and lose the thinking text entirely.
          if (block.thinking) {
            send({ type: 'message', msgType: 'thinking', content: block.thinking, sessionId: msg.session_id });
          }
        } else if (block.type === 'text') {
          if (block.text) {
            send({ type: 'message', msgType: 'text', content: block.text, sessionId: msg.session_id });
          }
        } else if (block.type === 'tool_use') {
          send({
            type: 'message', msgType: 'tool_use', content: '',
            toolName: block.name, toolInput: block.input, toolUseId: block.id,
            parentToolUseId: msg.parent_tool_use_id ?? undefined, sessionId: msg.session_id,
          });
          // Mirror plan-style tools into the sticky panel for parity with Copilot's plan API.
          // ExitPlanMode: initial plan submission; TodoWrite: ongoing task list updates.
          if (block.name === 'TodoWrite') {
            const todos = (block.input as any)?.todos as Array<{ content: string; status: string; activeForm?: string }> | undefined;
            if (Array.isArray(todos)) {
              const md = todos.map((t) => {
                if (t.status === 'completed') return `- [x] ${t.content}`;
                if (t.status === 'in_progress') return `- [~] ${t.activeForm ?? t.content}`;
                return `- [ ] ${t.content}`;
              }).join('\n');
              send({ type: 'message', msgType: 'plan_update', content: md });
            }
          } else if (block.name === 'ExitPlanMode') {
            const plan = (block.input as any)?.plan;
            if (typeof plan === 'string') {
              send({ type: 'message', msgType: 'plan_update', content: plan });
            }
          }
        }
      }
      if (msg.message.usage) {
        const isSubagent = msg.parent_tool_use_id != null;
        const modelRaw = msg.message.model;
        const isSynthetic = typeof modelRaw === 'string' && modelRaw.startsWith('<');
        if (!isSubagent && !isSynthetic) {
          const u = msg.message.usage as any;
          lastTurnUsage = {
            input_tokens: u.input_tokens ?? 0,
            cache_read_input_tokens: u.cache_read_input_tokens,
            cache_creation_input_tokens: u.cache_creation_input_tokens,
          };
          if (typeof modelRaw === 'string') lastTurnModel = modelRaw;
        }
        send({
          type: 'status', state: 'streaming',
          ...(isSubagent || isSynthetic ? {} : { model: modelRaw }),
          inputTokens: msg.message.usage.input_tokens, outputTokens: msg.message.usage.output_tokens,
          sessionId: msg.session_id,
        });
      }
      break;
    }
    case 'stream_event': {
      const event: any = (msg as any).event;
      if (event?.type === 'content_block_delta' && event.delta) {
        const delta = event.delta;
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
          send({ type: 'stream', streamType: 'text', content: delta.text });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
          send({ type: 'stream', streamType: 'thinking', content: delta.thinking });
        }
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
      let contextUsage: StatusSegment | undefined;
      if (isSuccess) {
        const u = lastTurnUsage ?? (msg.usage as any);
        const mu: any = (msg as any).modelUsage;
        const preferred = mu && lastTurnModel && mu[lastTurnModel] ? mu[lastTurnModel] : (mu && Object.values(mu)[0]);
        const window = (preferred as any)?.contextWindow as number | undefined;
        if (u && window && window > 0) {
          const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          const ratio = used / window;
          contextUsage = {
            text: `ctx: ${Math.round(ratio * 100)}%`,
            severity: severityFromUtilization(ratio),
          };
        }
      }
      lastTurnUsage = null;
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
        contextUsage,
      });
      break;
    }
    case 'system': {
      if (msg.subtype === 'init') {
        send({ type: 'status', state: 'streaming', model: msg.model, sessionId: msg.session_id });
      }
      break;
    }
    case 'rate_limit_event': {
      const info = (msg as any).rate_limit_info;
      if (info && typeof info.utilization === 'number') {
        const label = RATE_LIMIT_LABELS[info.rateLimitType] ?? info.rateLimitType ?? 'quota';
        const pct = Math.round(info.utilization * 100);
        const reset = info.resetsAt ? formatResetCountdown(info.resetsAt) : null;
        // 'rejected' status means hard cap reached — escalate severity regardless of pct.
        const severity = info.status === 'rejected'
          ? 'critical'
          : info.status === 'allowed_warning'
            ? 'warning'
            : severityFromUtilization(info.utilization);
        send({
          type: 'status', state: 'streaming',
          sessionId: (msg as any).session_id,
          rateLimits: [{
            text: `${label}: ${pct}%${reset ? ` ↻${reset}` : ''}`,
            severity,
          }],
        });
      }
      break;
    }
  }
}
