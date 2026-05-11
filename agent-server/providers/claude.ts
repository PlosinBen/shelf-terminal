import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query, Options, SDKMessage, CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'fs';
import { resolve } from 'path';
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

/**
 * Defaults applied to every real query we issue. NOT used for the warmup
 * query in `ensureInit` — that one only needs to reach the SDK init handshake
 * and deliberately omits `tools`/`thinking`/`includePartialMessages` so it
 * stays cheap.
 *
 * If you add a new SDK option that should apply to all real queries, add it
 * here, not at individual call sites — `thinking.display` was previously
 * easy to miss and caused dev/packaged behaviour divergence (see GOTCHAS).
 */
const CLAUDE_QUERY_DEFAULTS = {
  pathToClaudeCodeExecutable: CLAUDE_BINARY_PATH,
  tools: { type: 'preset', preset: 'claude_code' },
  thinking: { type: 'adaptive', display: 'summarized' },
  includePartialMessages: true,
} as const satisfies Partial<Options>;

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
      // Seed in-memory session ID from orchestrator-provided context. Only
      // applied on the first turn of this process — once `lastSessionId` is
      // captured from a live `session_id`, we don't clobber it.
      if (!lastSessionId && input.restoreContext?.lastSdkSessionId) {
        lastSessionId = input.restoreContext.lastSdkSessionId;
      }
      const mode = (input.permissionMode as Options['permissionMode']) ?? 'default';
      const isBypass = mode === 'bypassPermissions';
      // DIY bypass: SDK stays at 'default' and our canUseTool short-circuits to allow.
      // Avoids SDK's `allowDangerouslySkipPermissions` flag and keeps plan/acceptEdits
      // SDK-native (those have non-trivial built-in semantics worth keeping).
      const effectiveCanUseTool: CanUseTool = isBypass
        ? ((async (_n, toolInput) => ({ behavior: 'allow' as const, updatedInput: toolInput })) as CanUseTool)
        : canUseTool;
      const options: Options = {
        ...CLAUDE_QUERY_DEFAULTS,
        abortController,
        cwd: input.cwd,
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
          processMessage(sdkMsg, send, input.cwd);
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          send({ type: 'error', error: err.message ?? 'Unknown error' });
        }
        // Always emit idle so the main process's streamRemoteEvents loop
        // terminates and the UI flips out of "streaming" state. Without this
        // the for-await caller hangs forever after an SDK error and the
        // session stays stuck — even AbortError needs the idle to release it.
        send({ type: 'status', state: 'idle' });
      } finally {
        for (const resolve of pendingPermissions.values()) {
          resolve({ behavior: 'deny', message: 'Session ended' });
        }
        pendingPermissions.clear();
        activeQuery = null;
        abortController = null;
        // Tell orchestrator to persist the latest SDK session_id so the next
        // process can resume. Single emit per turn — avoids disk thrash on
        // every chunk. Mid-turn crash tolerance: at worst the user loses the
        // in-flight turn and resumes from the previous turn's session_id,
        // which is still correct because the SDK rolls forward a single jsonl
        // per resume chain.
        if (lastSessionId) {
          send({ type: 'context_patch', patch: { lastSdkSessionId: lastSessionId } });
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

    resetSession(_sessionId: string) {
      // Drop our resume pointer; SDK has no per-session in-memory state we own.
      // Next query() with no `restoreContext.lastSdkSessionId` will start fresh.
      lastSessionId = null;
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
        currentSend?.({ type: 'message', msgType: 'plan', content: '' });
        inflightToolUses.clear();
        // Eager-clear in-memory + persisted session id so the edge case
        // "/clear then close app before SDK responds" doesn't leave a stale
        // resume pointer in context-store. Steady-state correctness is
        // already handled by the SDK assigning a new session_id on the next
        // assistant message (captured in the for-await loop and emitted as
        // context_patch), but if the user closes mid-flight we'd otherwise
        // hydrate the pre-clear session id on next launch and resume it.
        lastSessionId = null;
        currentSend?.({ type: 'context_patch', patch: { lastSdkSessionId: null } });
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

/**
 * In-flight tool calls awaiting their `tool_result` event. Keyed by toolUseId.
 * Stores the canonical wire payload of the original `tool_use` / `file_edit`
 * emit so we can re-emit the same shape with `result` populated when the
 * matching tool_result arrives — renderer upserts by toolUseId, so the
 * second message must carry the full payload, not just the result delta.
 *
 * Module-level is fine: one createClaudeBackend per agent-server process.
 */
type InflightToolUseEntry =
  | { kind: 'tool_use'; toolName: string; input: string }
  | { kind: 'file_edit'; filePath: string; diff?: { oldString: string; newString: string }; content?: string };
const inflightToolUses = new Map<string, InflightToolUseEntry>();

function stripCwd(p: string, cwd: string): string {
  if (!cwd || !p) return p;
  if (p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return p;
}

/**
 * Format a Claude SDK tool's `input` object into a single human-readable
 * string for the renderer. Renderer treats the result as opaque text and only
 * does CSS truncation — all "what's the headline of this tool call" logic
 * lives here in the provider, where SDK semantics are already known.
 *
 * Falls back to JSON for unknown tools so MCP custom tools still display
 * something instead of a blank line.
 */
export function formatClaudeToolInput(toolName: string, input: Record<string, unknown>, cwd: string): string {
  switch (toolName) {
    case 'Bash':
      return String(input.command ?? '');
    case 'Read': {
      const fp = String(input.file_path ?? '');
      const off = input.offset != null ? Number(input.offset) : null;
      const lim = input.limit != null ? Number(input.limit) : null;
      const range = off != null || lim != null
        ? ` (${off ?? 0}${lim != null ? `..+${lim}` : ''})`
        : '';
      return stripCwd(fp, cwd) + range;
    }
    case 'Grep': {
      const pattern = String(input.pattern ?? '');
      const path = input.path ? ` in ${stripCwd(String(input.path), cwd)}` : '';
      return pattern + path;
    }
    case 'Glob': {
      const pattern = String(input.pattern ?? '');
      const path = input.path ? ` in ${stripCwd(String(input.path), cwd)}` : '';
      return pattern + path;
    }
    case 'WebFetch':
      return String(input.url ?? '');
    case 'WebSearch':
      return String(input.query ?? '');
    case 'Task': {
      const desc = input.description ?? input.subagent_type ?? '';
      const prompt = String(input.prompt ?? '');
      return desc ? `${desc}: ${prompt.slice(0, 80)}` : prompt.slice(0, 120);
    }
    default: {
      // Generic fallback: first string value if any (most SDK tools have one
      // dominant arg), else JSON.
      const firstStr = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      if (firstStr) return firstStr;
      return JSON.stringify(input);
    }
  }
}

/** Translate a Claude SDK `tool_use` block to either canonical `file_edit` or `tool_use`. */
function emitClaudeToolUse(
  send: SendFn,
  block: { id: string; name: string; input: Record<string, unknown> },
  cwd: string,
): void {
  if (block.name === 'Edit') {
    const input = block.input as { file_path?: string; old_string?: string; new_string?: string };
    if (typeof input.file_path === 'string'
      && typeof input.old_string === 'string'
      && typeof input.new_string === 'string') {
      const diff = { oldString: input.old_string, newString: input.new_string };
      inflightToolUses.set(block.id, { kind: 'file_edit', filePath: input.file_path, diff });
      send({
        type: 'message', msgType: 'file_edit',
        toolUseId: block.id,
        filePath: input.file_path,
        diff,
      });
      return;
    }
    // Malformed Edit — fall through to generic tool_use so we don't drop it.
  }
  if (block.name === 'Write') {
    const input = block.input as { file_path?: string; content?: string };
    if (typeof input.file_path === 'string' && typeof input.content === 'string') {
      inflightToolUses.set(block.id, {
        kind: 'file_edit', filePath: input.file_path, content: input.content,
      });
      send({
        type: 'message', msgType: 'file_edit',
        toolUseId: block.id,
        filePath: input.file_path,
        content: input.content,
      });
      return;
    }
    // Fall through.
  }
  const input = formatClaudeToolInput(block.name, block.input, cwd);
  inflightToolUses.set(block.id, {
    kind: 'tool_use', toolName: block.name, input,
  });
  send({
    type: 'message', msgType: 'tool_use',
    toolUseId: block.id,
    toolName: block.name,
    input,
  });
}

/** Re-emit the original tool_use/file_edit message with `result` populated. */
function emitClaudeToolResult(
  send: SendFn,
  toolUseId: string,
  content: string,
  isError: boolean,
): void {
  const entry = inflightToolUses.get(toolUseId);
  if (!entry) return;
  inflightToolUses.delete(toolUseId);
  if (entry.kind === 'file_edit') {
    send({
      type: 'message', msgType: 'file_edit',
      toolUseId,
      filePath: entry.filePath,
      ...(entry.diff ? { diff: entry.diff } : {}),
      ...(entry.content !== undefined ? { content: entry.content } : {}),
      result: isError
        ? { success: false, error: content }
        : { success: true },
    });
  } else {
    send({
      type: 'message', msgType: 'tool_use',
      toolUseId,
      toolName: entry.toolName,
      input: entry.input,
      result: { content, ...(isError ? { isError: true } : {}) },
    });
  }
}

// Accumulate rate-limit buckets across events so we can always send the full
// set to the UI.  Key = bucket label (e.g. '5h', '7d').
const rateLimitBuckets = new Map<string, StatusSegment>();

function processMessage(msg: SDKMessage, send: SendFn, cwd: string) {
  switch (msg.type) {
    case 'assistant': {
      for (const block of msg.message.content) {
        if (block.type === 'thinking') {
          send({ type: 'message', msgType: 'thinking', content: block.thinking });
        } else if (block.type === 'text') {
          send({ type: 'message', msgType: 'text', content: block.text });
        } else if (block.type === 'tool_use') {
          emitClaudeToolUse(send, { id: block.id, name: block.name, input: block.input as Record<string, unknown> }, cwd);
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
              send({ type: 'message', msgType: 'plan', content: md });
            }
          } else if (block.name === 'ExitPlanMode') {
            const plan = (block.input as any)?.plan;
            if (typeof plan === 'string') {
              send({ type: 'message', msgType: 'plan', content: plan });
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
            const raw = (block as any).content;
            const content = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
            emitClaudeToolResult(send, (block as any).tool_use_id, content, (block as any).is_error === true);
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
      // `result` msgType was a dead channel — token/cost data is sent via the
      // status payload below; renderer never used the message form. Drop it.
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
