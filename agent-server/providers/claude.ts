import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query, Options, SDKMessage, CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { QueryInput, SendFn, ServerBackend, ProviderCapabilities, SlashResult, StatusSegment } from './types';
import { severityFromUtilization, formatResetCountdown, pickPermissionModes, pickEffortLevels } from './types';
import { loadContext, saveContext } from '../context-store';
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

/**
 * Convert Claude's `SDKRateLimitInfo` to a `StatusSegment`.
 *
 * Two SDK quirks we work around:
 * 1. `utilization` is only populated when `status === 'allowed_warning' | 'rejected'` —
 *    on `'allowed'` it is silently dropped even though the underlying
 *    `anthropic-ratelimit-unified-*-utilization` headers always carry it.
 *    We render `5h: — ↻3h` so the bucket + countdown are still visible.
 * 2. `resetsAt` is a Unix timestamp in *seconds*, but `formatResetCountdown`
 *    expects milliseconds — multiply by 1000.
 *
 * Returns `null` when there is nothing useful to display.
 */
export function rateLimitInfoToSegment(info: any): StatusSegment | null {
  if (!info) return null;

  const label = RATE_LIMIT_LABELS[info.rateLimitType] ?? info.rateLimitType ?? 'quota';
  const hasPct = typeof info.utilization === 'number';
  const pctText = hasPct ? `${Math.round(info.utilization * 100)}%` : '—';
  const reset = typeof info.resetsAt === 'number'
    ? formatResetCountdown(info.resetsAt * 1000)
    : null;

  // 'rejected' = hard cap; 'allowed_warning' = SDK-flagged warning. Severity
  // from utilization only kicks in on 'allowed' when we actually have a number.
  const severity: StatusSegment['severity'] = info.status === 'rejected'
    ? 'critical'
    : info.status === 'allowed_warning'
      ? 'warning'
      : hasPct
        ? severityFromUtilization(info.utilization)
        : 'normal';

  return {
    text: `${label}: ${pctText}${reset ? ` ↻${reset}` : ''}`,
    severity,
  };
}

type PermissionResult =
  | { behavior: 'allow'; scope?: 'once' | 'session' }
  | { behavior: 'deny'; message?: string };

const CLAUDE_AUTH_METHOD = {
  kind: 'sdk-managed' as const,
  instructions: [{ label: 'Sign in to Claude via the CLI', command: 'claude login' }],
};

/**
 * Resolve the bundled `claude` binary path.
 *
 * The SDK's auto-resolution uses `require.resolve` relative to the SDK
 * package, but esbuild bundles the SDK into agent-server.mjs so that
 * resolution path no longer points to a real `node_modules` location. In
 * packaged Electron, even a working `require.resolve` would land inside
 * `app.asar` (virtual fs) instead of `app.asar.unpacked` where the binary
 * actually sits. We do path resolution explicitly to cover both cases.
 *
 * Returns `undefined` only if the binary really isn't on disk (e.g. wrong
 * arch was packaged); the SDK then falls back to PATH lookup which usually
 * finds a globally installed `claude` of a possibly mismatched version —
 * acceptable degraded behaviour, not silent breakage.
 */
function resolveClaudeBinary(): string | undefined {
  const platform = process.platform;
  const arch = process.arch;
  const pkgName = `claude-agent-sdk-${platform}-${arch}`;

  const candidates = [
    // Dev: node_modules sibling to source tree
    resolve(__dirname, '..', 'node_modules', '@anthropic-ai', pkgName, 'claude'),
    // Dev (built): __dirname is dist/agent-server/<version>/, three levels up to project root
    resolve(__dirname, '..', '..', '..', 'node_modules', '@anthropic-ai', pkgName, 'claude'),
    // Packaged Electron: __dirname is Resources/agent-server/<version>/, ../../ → Resources/, then app.asar.unpacked/...
    resolve(__dirname, '..', '..', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', pkgName, 'claude'),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

// Resolve once at module load. Path layout doesn't change at runtime, so
// re-running existsSync per query is wasted work and clutters call sites.
const CLAUDE_BINARY_PATH = resolveClaudeBinary();

export function createClaudeBackend(): ServerBackend {
  let activeQuery: Query | null = null;
  let abortController: AbortController | null = null;
  const cache: { models?: any[]; commands?: any[] } = {};
  let initPromise: Promise<void> | null = null;
  let lastSessionId: string | null = null;
  /**
   * Tracks which app-level sessionIds we've already seeded `lastSessionId`
   * from disk for in this process. Seeding is idempotent — once per sessionId
   * per process — so a tab that swaps cwd / model mid-session still resumes
   * from the correct jsonl on the next process restart.
   */
  const seededSessions = new Set<string>();

  /**
   * Hydrate `lastSessionId` from `~/.shelf/agent-context/<sessionId>.json` so
   * the SDK can resume the previous conversation jsonl after an app/process
   * restart. No-op on subsequent calls within the same process — once seeded,
   * `lastSessionId` is the source of truth and gets updated in-memory by
   * each turn's `session_id` capture.
   */
  function seedSessionFromDisk(sessionId: string | undefined): void {
    if (!sessionId || seededSessions.has(sessionId)) return;
    seededSessions.add(sessionId);
    // Only seed if we don't already have an in-memory id (defensive: avoid
    // clobbering a fresh session_id captured during a prior turn).
    if (lastSessionId) return;
    const ctx = loadContext(sessionId);
    if (ctx?.lastSdkSessionId) {
      lastSessionId = ctx.lastSdkSessionId;
    }
  }

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
          pathToClaudeCodeExecutable: CLAUDE_BINARY_PATH,
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
    async gatherCapabilities(cwd: string, sessionId?: string, customModels?: ProviderModel[]): Promise<ProviderCapabilities> {
      await ensureInit(cwd);
      seedSessionFromDisk(sessionId);
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
      // Defensive seed: in case `gatherCapabilities` was skipped (e.g. capability
      // cache hit on a different sessionId before this one), make sure we
      // resume from disk on the very first turn after a process restart.
      seedSessionFromDisk(input.sessionId);
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
        // Must be explicit — SDK's auto-resolution looks for the binary
        // relative to the SDK package, but esbuild bundles the SDK into
        // agent-server.mjs so that path no longer points anywhere useful.
        // Symptom when undefined in packaged builds: assistant blocks arrive
        // with `signature` but `thinking: ""`, and no streaming deltas.
        pathToClaudeCodeExecutable: CLAUDE_BINARY_PATH,
        tools: { type: 'preset', preset: 'claude_code' },
        // `display: 'summarized'` is critical: without it, the SDK pushes
        // `--thinking adaptive` to the CLI but omits `--thinking-display`,
        // which lets the CLI fall back to env/TTY-based default. In packaged
        // builds (stripped env, no TERM_PROGRAM) the default resolves to
        // 'omitted' → assistant blocks arrive with `signature` but `thinking: ""`
        // and no thinking_delta stream events. Setting it explicitly makes
        // the behaviour deterministic.
        thinking: { type: 'adaptive', display: 'summarized' },
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
        // Persist the latest SDK session_id so the next process can resume.
        // Single write per turn — avoids disk thrash on every chunk. We tolerate
        // crashes mid-turn: at worst the user loses the in-flight turn and
        // resumes from the previous turn's session_id, which is still correct
        // because the SDK rolls forward a single jsonl per resume chain.
        if (input.sessionId && lastSessionId) {
          try {
            saveContext({
              sessionId: input.sessionId,
              provider: 'claude',
              lastSdkSessionId: lastSessionId,
              updatedAt: Date.now(),
            });
          } catch {
            // Persistence is best-effort — don't fail the turn.
          }
        }
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

// Accumulate rate-limit buckets across events so we can always send the full
// set to the UI.  Key = bucket label (e.g. '5h', '7d').
const rateLimitBuckets = new Map<string, StatusSegment>();

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
      // Trace: SDK only emits rate_limit_event for claude.ai subscription users
      // and only "when rate limit info changes". Log every event so we can
      // verify cadence + payload shape if quota segment fails to render.
      console.error('[rate-limit-trace] event received, info=', JSON.stringify(info));
      const seg = rateLimitInfoToSegment(info);
      if (seg) {
        const bucketKey = seg.text.split(':')[0];
        rateLimitBuckets.set(bucketKey, seg);
        send({
          type: 'status', state: 'streaming',
          sessionId: (msg as any).session_id,
          rateLimits: [...rateLimitBuckets.values()],
        });
      }
      break;
    }
  }
}
