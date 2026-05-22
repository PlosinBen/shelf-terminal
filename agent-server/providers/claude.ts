import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query, Options, SDKMessage, CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { QueryInput, SendFn, ServerBackend, ProviderCapabilities, StatusSegment, PickerResolvePayload } from './types';
import { severityFromUtilization, formatResetCountdown, pickPermissionModes, pickEffortLevels } from './types';
import { parseSlashPrefix } from '../../src/shared/slash-prefix';
import type { ProviderModel } from '../../src/shared/types';

/**
 * Mint a unique msgId for slash_response messages (no SDK-provided id like
 * tool_use has). 8-char random suffix keeps logs readable while collision-free
 * within reasonable lifetimes.
 */
function mintSlashMsgId(): string {
  return `s-${randomUUID().slice(0, 8)}`;
}

// Claude SDK's `supportedCommands()` only returns user-installed skills, not
// built-ins. Append these so the autocomplete menu lists them; submission still
// passes through to the SDK, which handles them natively.
//
// /model intentionally not listed — it's a renderer-local config-edit slash
// (see src/renderer/components/AgentView.tsx RENDERER_LOCAL_SLASHES), and the
// renderer merges its own command list into the autocomplete display.
const CLAUDE_BUILTIN_COMMANDS = [
  { name: 'clear', description: 'Reset the conversation context' },
  { name: 'compact', description: 'Compact the conversation' },
  // /help 尚未實作 provider-side dispatch — SDK 不會原生回 command list，
  // 若列在 autocomplete 上送出去只會被當成普通 prompt 餵給模型。實作前先註解。
  // { name: 'help', description: 'List available slash commands' },
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

/** Sample of a preview field carried on an AskUserQuestion option. Logged by
 * the runtime caller — v1 picker UI doesn't render preview content yet
 * (v1 doesn't render preview content — see DECISIONS #57 "Out of scope"). */
export interface AskUserQuestionPreviewSample {
  question: string;
  optionLabel: string;
  previewLength: number;
  preview: string;
}

/** Output of `askUserQuestionToPrompts` — picker_request `prompts[]` plus
 * the original `questions` array (kept for the answer-JSON builder) plus
 * any preview samples the caller should log. */
export interface AskUserQuestionMapped {
  questions: Array<{ question: string; [k: string]: unknown }>;
  prompts: Array<{
    question: string;
    header?: string;
    multiSelect: boolean;
    options: Array<{ label: string; description?: string; preview?: string }>;
    inputType: 'text';
  }>;
  previewSamples: AskUserQuestionPreviewSample[];
}

/**
 * Pure mapper: AskUserQuestionInput → picker_request `prompts[]`.
 *
 * Returns `null` for malformed input (no questions array, or empty). Caller
 * uses that as the signal to reject the tool call with an explanatory deny
 * rather than emit an empty picker.
 *
 * `inputType: 'text'` is hardcoded — AskUserQuestion's spec auto-adds an
 * "Other" option to every question (sdk-tools.d.ts comment on `options`),
 * so the picker must always offer free-text entry alongside the listed
 * options.
 */
export function askUserQuestionToPrompts(input: Record<string, unknown>): AskUserQuestionMapped | null {
  const questions = Array.isArray((input as any)?.questions) ? (input as any).questions : null;
  if (!questions || questions.length === 0) return null;

  const previewSamples: AskUserQuestionPreviewSample[] = [];
  const prompts = questions.map((q: any) => {
    const options = Array.isArray(q?.options) ? q.options : [];
    for (const opt of options) {
      if (typeof opt?.preview === 'string' && opt.preview.length > 0) {
        previewSamples.push({
          question: String(q?.question ?? ''),
          optionLabel: String(opt?.label ?? ''),
          previewLength: opt.preview.length,
          preview: opt.preview,
        });
      }
    }
    return {
      question: String(q?.question ?? ''),
      header: typeof q?.header === 'string' ? q.header : undefined,
      multiSelect: !!q?.multiSelect,
      options: options.map((o: any) => ({
        label: String(o?.label ?? ''),
        description: typeof o?.description === 'string' ? o.description : undefined,
        preview: typeof o?.preview === 'string' ? o.preview : undefined,
      })),
      inputType: 'text' as const,
    };
  });

  return { questions, prompts, previewSamples };
}

/**
 * Pure builder: PickerResolvePayload answers → AskUserQuestionOutput JSON.
 *
 * Output shape per SDK spec (sdk-tools.d.ts:2530 AskUserQuestionOutput):
 *   { questions: [...echo], answers: { [questionText]: string } }
 *
 * Multi-select answers are comma-joined per SDK spec comment line 2688
 * ("multi-select answers are comma-separated"). `annotations` is omitted —
 * it's optional in the SDK schema, and we don't surface preview/notes in
 * v1 UI so there's nothing to echo back.
 */
export function buildAskUserQuestionAnswerJson(
  questions: Array<{ question: string; [k: string]: unknown }>,
  answers: Array<string | string[]>,
): string {
  const answersMap: Record<string, string> = {};
  questions.forEach((q, i) => {
    const ans = answers[i];
    answersMap[q.question] = Array.isArray(ans) ? ans.join(', ') : String(ans ?? '');
  });
  return JSON.stringify({ questions, answers: answersMap });
}

export function createClaudeBackend(): ServerBackend {
  let activeQuery: Query | null = null;
  let abortController: AbortController | null = null;
  const cache: { models?: any[]; commands?: any[] } = {};
  let initPromise: Promise<void> | null = null;
  let lastSessionId: string | null = null;

  const pendingPermissions = new Map<string, (result: PermissionResult) => void>();
  let currentSend: SendFn | null = null;

  // Non-cancellable critical-section flag (see Copilot's matching helper for
  // rationale). Wraps Claude's `/compact` SDK turn so stop() silently no-ops
  // mid-compaction — interrupting half-way would leave the SDK session in an
  // indeterminate compacted/un-compacted state.
  let stoppable = true;

  // Pending picker promises keyed by picker id (= AskUserQuestion toolUseID).
  // resolvePicker drains the entry with renderer's PickerResolvePayload —
  // either index-aligned answers or { cancelled: true }.
  const pendingPickers = new Map<string, (payload: PickerResolvePayload) => void>();

  // Set per-query() based on permissionMode === 'bypassPermissions'. Read
  // inside canUseTool so bypass short-circuits non-AskUserQuestion tools
  // *without* skipping the AskUserQuestion intercept itself.
  let currentBypassMode = false;

  const canUseTool: CanUseTool = (async (toolName, input, canUseOpts) => {
    const toolUseId = (canUseOpts as any)?.toolUseID ?? `sdk-${Date.now()}`;

    // AskUserQuestion: SDK 0.2.126 has no `onAskUserQuestion` callback, but
    // canUseTool fires for every tool including this one. We intercept here,
    // round-trip the questions to the renderer via picker_request, then
    // smuggle the SDK-shaped answer JSON back through canUseTool's deny
    // message — the model treats deny content as tool_result content (despite
    // `is_error: true` on the wire). Spike-verified: scripts/spike-askuser.ts.
    //
    // Must run BEFORE the bypass-mode short-circuit below — in bypass mode we
    // still want to surface AskUserQuestion as a picker (bypass means "skip
    // tool permission gating", not "skip user-facing interaction prompts").
    if (toolName === 'AskUserQuestion') {
      return handleAskUserQuestion(input, toolUseId, canUseOpts?.signal);
    }

    // DIY bypass: SDK stays at 'default' permissionMode and our canUseTool
    // short-circuits to allow. Avoids SDK's `allowDangerouslySkipPermissions`
    // flag and keeps plan/acceptEdits SDK-native (those have non-trivial
    // built-in semantics worth keeping).
    if (currentBypassMode) {
      return { behavior: 'allow', updatedInput: input };
    }

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

  /**
   * Translate an AskUserQuestion tool_use into a picker_request, await the
   * renderer's answer, and shape the response back into the SDK's expected
   * `AskUserQuestionOutput` JSON. Cancellation (user dismiss, abort signal)
   * returns a plain-text deny so the model can decide how to proceed.
   *
   * The pure mapping logic is factored into module-level helpers
   * (askUserQuestionToPrompts / buildAskUserQuestionAnswerJson) so unit
   * tests can exercise the wire transformation without spinning up a
   * full backend / SDK session.
   */
  async function handleAskUserQuestion(
    input: Record<string, unknown>,
    toolUseId: string,
    signal?: AbortSignal,
  ): Promise<PermissionResult> {
    const mapped = askUserQuestionToPrompts(input);
    if (!mapped) {
      // Malformed input — fail loud rather than silently send empty answers.
      return { behavior: 'deny', message: 'AskUserQuestion received with no questions' };
    }
    for (const sample of mapped.previewSamples) {
      console.warn('[picker] preview content received, not rendered yet', sample);
    }

    currentSend?.({ type: 'picker_request', id: toolUseId, prompts: mapped.prompts });

    const resolved = await new Promise<PickerResolvePayload>((resolve) => {
      pendingPickers.set(toolUseId, resolve);
      // Abort path: if the turn is cancelled mid-picker, force-resolve as
      // cancelled so the SDK can wind the turn down cleanly. The signal may
      // fire either before pendingPickers has the entry (race) or after —
      // the once-listener handles both.
      signal?.addEventListener('abort', () => {
        if (pendingPickers.has(toolUseId)) {
          pendingPickers.delete(toolUseId);
          resolve({ cancelled: true });
        }
      }, { once: true });
    });

    if ('cancelled' in resolved) {
      return { behavior: 'deny', message: 'User declined to answer' };
    }

    return {
      behavior: 'deny',
      message: buildAskUserQuestionAnswerJson(mapped.questions, resolved.answers),
    };
  }

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
    async gatherCapabilities(
      cwd: string,
      _sessionId?: string,
      customModels?: ProviderModel[],
      _intent?: { model?: string; effort?: string; permissionMode?: string },
    ): Promise<ProviderCapabilities> {
      // intent unused — Claude has no session-level state to seed; per-call
      // QueryInput.{model,effort,permissionMode} fully drives behavior.
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
      // Flip the closure flag so canUseTool's bypass short-circuit takes
      // effect for this query. Single canUseTool path keeps the
      // AskUserQuestion intercept active regardless of permission mode.
      currentBypassMode = isBypass;
      const options: Options = {
        ...CLAUDE_QUERY_DEFAULTS,
        abortController,
        cwd: input.cwd,
        permissionMode: isBypass ? 'default' : mode,
        canUseTool,
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

      // Per-turn map: SDK content_block index → our msgId. Lazily populated
      // on first stream_delta or assistant block ref; cleared after each
      // assistant message (next assistant resets its index space).
      const blockMsgIds: BlockMsgIdState = createBlockMsgIdState();

      // Idle-emit dedup. Three idle emit sites in query():
      //   1. processMessage's `result` case — success path, carries metrics
      //   2. catch block — error / abort path
      //   3. finally block — safety net for the case where SDK iteration
      //      ends without hitting result or catch (rare)
      //
      // Without dedup, normal turns double-emit (result + finally on success,
      // catch + finally on error). The second arrives after turn-dispatcher
      // already unregistered the turn (first idle marks turn.done) and gets
      // logged as "event for unknown turn ... dropping". Wrap `send` with
      // an idle-dedup guard so only the first idle of this turn goes through.
      let idleEmitted = false;
      const turnSend: SendFn = (msg) => {
        if (msg.type === 'status' && (msg as any).state === 'idle') {
          if (idleEmitted) return;
          idleEmitted = true;
        }
        send(msg);
      };

      // Slash detection — most slashes are forwarded to the SDK unchanged
      // (SDK natively interprets `/cmd` strings and replies with assistant
      // text). We only side-effect on slashes that need provider-side
      // bookkeeping the SDK can't reach:
      //   - `/clear`: reset our in-memory lastSessionId and emit
      //     context_patch so persistence doesn't resurrect the dead session
      //     on next launch. Slash flows through send → query() so this
      //     side-effect lives here, not in a separate IPC handler.
      //   - `/compact`: capture completion via SDKCompactBoundaryMessage +
      //     SDKStatusMessage and surface as a slash_response card with
      //     token deltas (otherwise SDK swallows the outcome silently).
      const slash = parseSlashPrefix(input.prompt);
      if (slash?.cmd === 'clear') {
        send({ type: 'message', msgId: mintMsgId(), msgType: 'plan', content: '' });
        inflightToolUses.clear();
        lastSessionId = null;
        send({ type: 'context_patch', patch: { lastSdkSessionId: null } });
        // Fall through — SDK still handles the actual /clear semantics.
      }
      let pendingCompactMsgId: string | null = null;
      let compactMeta: { pre_tokens?: number; post_tokens?: number; duration_ms?: number } | null = null;
      if (slash?.cmd === 'compact') {
        pendingCompactMsgId = mintSlashMsgId();
        send({
          type: 'message', msgId: pendingCompactMsgId, msgType: 'slash_response',
          slashCmd: 'compact', status: 'pending', content: 'Compacting...',
        });
        // Whole compact turn is critical — stop() silently no-ops until done.
        stoppable = false;
      }

      try {
        for await (const sdkMsg of activeQuery) {
          if ('session_id' in sdkMsg && sdkMsg.session_id) {
            lastSessionId = sdkMsg.session_id as string;
          }

          // /compact completion detection — must run before processMessage so
          // we capture metadata from the system message while it's in scope.
          // SDK emits two relevant events: subtype 'compact_boundary' carries
          // pre/post token counts; subtype 'status' with compact_result is
          // the terminal success/failure flag.
          if (pendingCompactMsgId && sdkMsg.type === 'system') {
            const subtype = (sdkMsg as any).subtype;
            if (subtype === 'compact_boundary') {
              compactMeta = (sdkMsg as any).compact_metadata ?? null;
            } else if (subtype === 'status' && (sdkMsg as any).compact_result) {
              const result = (sdkMsg as any).compact_result as 'success' | 'failed';
              if (result === 'success') {
                const pre = compactMeta?.pre_tokens?.toLocaleString() ?? '?';
                const post = compactMeta?.post_tokens?.toLocaleString() ?? '?';
                const dur = compactMeta?.duration_ms
                  ? ` in ${(compactMeta.duration_ms / 1000).toFixed(1)}s`
                  : '';
                send({
                  type: 'message', msgId: pendingCompactMsgId, msgType: 'slash_response',
                  slashCmd: 'compact', status: 'success',
                  content: `Compacted: ${pre} → ${post} tokens${dur}`,
                });
              } else {
                const errMsg = (sdkMsg as any).compact_error ?? 'Compaction failed';
                send({
                  type: 'message', msgId: pendingCompactMsgId, msgType: 'slash_response',
                  slashCmd: 'compact', status: 'error',
                  content: `Compact failed: ${errMsg}`,
                });
              }
              pendingCompactMsgId = null;
              compactMeta = null;
              stoppable = true;
            }
          }

          processMessage(sdkMsg, turnSend, input.cwd, blockMsgIds);
        }
      } catch (err: any) {
        // Two arrival timings for catch:
        //   (a) BEFORE result case ran (SDK threw mid-stream) — turn never
        //       reached idle; emit error + idle to release main.
        //   (b) AFTER result case ran (SDK threw during post-result cleanup
        //       / abort teardown) — idle was already emitted by `result`,
        //       main has deregistered the turn. Re-emitting error here
        //       would arrive at an "unknown turn" and just clutter logs.
        //       The user already got their result; the teardown error is
        //       provider-internal noise.
        if (!idleEmitted) {
          if (err.name !== 'AbortError') {
            send({ type: 'error', error: err.message ?? 'Unknown error' });
          }
          turnSend({ type: 'status', state: 'idle' });
        } else if (err.name !== 'AbortError') {
          // Log to stderr so it still surfaces in agent-server.log for
          // postmortem — just not over the wire.
          console.error('[claude] post-idle SDK error suppressed:', err?.message ?? err);
        }
      } finally {
        for (const resolve of pendingPermissions.values()) {
          resolve({ behavior: 'deny', message: 'Session ended' });
        }
        pendingPermissions.clear();
        activeQuery = null;
        abortController = null;

        // Compact turn ended without a terminal status event — emit a
        // generic error so the pending slash_response card doesn't sit
        // forever waiting for an outcome. Reachable on SDK error / abort.
        if (pendingCompactMsgId) {
          send({
            type: 'message', msgId: pendingCompactMsgId, msgType: 'slash_response',
            slashCmd: 'compact', status: 'error',
            content: 'Compaction did not complete',
          });
          pendingCompactMsgId = null;
        }
        stoppable = true;

        // Tell orchestrator to persist the latest SDK session_id so the next
        // process can resume. Single emit per turn — avoids disk thrash on
        // every chunk. Mid-turn crash tolerance: at worst the user loses the
        // in-flight turn and resumes from the previous turn's session_id,
        // which is still correct because the SDK rolls forward a single jsonl
        // per resume chain.
        if (lastSessionId) {
          send({ type: 'context_patch', patch: { lastSdkSessionId: lastSessionId } });
        }
        turnSend({ type: 'status', state: 'idle' });
      }
    },

    async stop() {
      // Silently ignore mid-compaction (or any other critical section the
      // provider sets `stoppable = false` for). Interrupting `/compact`
      // half-way leaves the SDK session in an indeterminate state.
      if (!stoppable) return;
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

    resolvePicker(id: string, payload: PickerResolvePayload) {
      const resolve = pendingPickers.get(id);
      if (resolve) {
        pendingPickers.delete(id);
        resolve(payload);
      }
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

/**
 * Unwrap a Claude SDK tool_result `content` payload into a plain string for
 * the renderer. SDK delivers it as either:
 *   - string (legacy / simple tools)
 *   - array of content blocks: `[{ type: 'text', text: '...' }, ...]` (Task /
 *     Agent sub-agent returns this shape; MCP tools may too)
 *   - (rare) other structured shapes — JSON-stringify as last resort
 *
 * Earlier code blindly `JSON.stringify`d the array form, surfacing
 * `[{"type":"text","text":"..."}]` to the user. Unwrap text blocks so the
 * renderer's <pre> shows readable output.
 */
export function extractToolResultText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const parts = raw.map((b) => {
      if (typeof b === 'string') return b;
      if (b && typeof b === 'object') {
        const block = b as { type?: string; text?: string };
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
      }
      return JSON.stringify(b);
    });
    return parts.join('\n');
  }
  return JSON.stringify(raw);
}

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
    // Claude SDK uses both `Task` (older) and `Agent` (newer claude-code SDK)
    // for sub-agent dispatch. Same input shape: `{ description, subagent_type,
    // prompt }`. Treat them identically — header surfaces the human-friendly
    // description plus a prompt preview, not the whole prompt blob.
    case 'Task':
    case 'Agent': {
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

/**
 * Mint a unique msgId for a non-tool message (text/thinking/intent/system/
 * error/plan). Tool messages use the SDK-provided toolUseId as their msgId
 * — see `emitClaudeToolUse`. 8 hex chars is plenty within a single
 * agent-server process lifetime; collisions across processes don't matter
 * because the renderer's message store is also process-scoped.
 */
function mintMsgId(): string {
  return `m-${randomUUID().slice(0, 8)}`;
}

/**
 * Per-turn state mapping SDK stream block index → our msgId, plus the
 * highest absolute block index announced so far by `content_block_start`.
 * Reset on `message_start` for a fresh assistant message.
 *
 * Why we need `lastBlockStartIdx`: the SDK emits `assistant` events whose
 * `message.content` array can be one of three shapes (which we cannot
 * distinguish by content shape alone):
 *
 *   (a) growing partial — same block re-emitted as its text grows;
 *       `content.length` stays 1 (or N), block index unchanged.
 *   (b) delta — each new block emitted alone; `content.length === 1`,
 *       index advances per emit. Empirically observed with
 *       `includePartialMessages: true`.
 *   (c) cumulative — all blocks so far in one emit; `content.length`
 *       equals current block count.
 *
 * Strategy: map `content[N-1]` to `lastBlockStartIdx`, `content[N-2]` to
 * `lastBlockStartIdx - 1`, etc. — i.e., positions are counted from the END
 * relative to the most recent block-start. This works for all three:
 *   (a) lastBlockStartIdx doesn't change between same-block emits → same id
 *   (b) lastBlockStartIdx advances with each new block → new id per emit
 *   (c) full cumulative emit aligns content[0..N-1] with indices
 *       [lastBlockStartIdx-N+1..lastBlockStartIdx]
 *
 * Bug this replaces: previously we used `forEach((b, i) => byIndex.get(i))`,
 * which silently treated in-batch position as absolute index. In delta mode
 * (b) that mis-aligns: a thinking-then-text turn would look up idx 0 for the
 * text finalize, hit the thinking block's msgId, and overwrite the thinking
 * entry with text — leaving the streamed-text entry under its real msgId
 * orphaned. Two text entries + no thinking.
 */
type BlockMsgIdState = {
  byIndex: Map<number, string>;
  lastBlockStartIdx: number; // -1 before any content_block_start
};

export function createBlockMsgIdState(): BlockMsgIdState {
  return { byIndex: new Map(), lastBlockStartIdx: -1 };
}

function getOrMintBlockMsgId(state: BlockMsgIdState, idx: number): string {
  let id = state.byIndex.get(idx);
  if (!id) {
    id = mintMsgId();
    state.byIndex.set(idx, id);
  }
  return id;
}

/** Translate a Claude SDK `tool_use` block to either canonical `file_edit` or `tool_use`. */
function emitClaudeToolUse(
  send: SendFn,
  block: { id: string; name: string; input: Record<string, unknown> },
  cwd: string,
): void {
  // For tool messages, msgId === toolUseId. Same identity, two named fields
  // (msgId is the universal renderer-side upsert key; toolUseId stays named
  // for permission_request pairing semantics).
  if (block.name === 'Edit') {
    const input = block.input as { file_path?: string; old_string?: string; new_string?: string };
    if (typeof input.file_path === 'string'
      && typeof input.old_string === 'string'
      && typeof input.new_string === 'string') {
      const diff = { oldString: input.old_string, newString: input.new_string };
      inflightToolUses.set(block.id, { kind: 'file_edit', filePath: input.file_path, diff });
      send({
        type: 'message', msgId: block.id, msgType: 'file_edit',
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
        type: 'message', msgId: block.id, msgType: 'file_edit',
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
    type: 'message', msgId: block.id, msgType: 'tool_use',
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
      type: 'message', msgId: toolUseId, msgType: 'file_edit',
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
      type: 'message', msgId: toolUseId, msgType: 'tool_use',
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

export function processMessage(msg: SDKMessage, send: SendFn, cwd: string, blockMsgIds: BlockMsgIdState) {
  switch (msg.type) {
    case 'assistant': {
      // Map content[] positions to absolute block indices by anchoring the
      // LAST entry to `lastBlockStartIdx`. See BlockMsgIdState docstring for
      // why this works across delta / growing-partial / cumulative shapes.
      const N = msg.message.content.length;
      const baseIdx = blockMsgIds.lastBlockStartIdx - N + 1;
      msg.message.content.forEach((block, i) => {
        const idx = baseIdx + i;
        if (block.type === 'thinking') {
          // Reuse msgId if stream chunks already minted one for this block;
          // otherwise (no streaming or non-streamed model) mint fresh.
          send({ type: 'message', msgId: getOrMintBlockMsgId(blockMsgIds, idx), msgType: 'thinking', content: block.thinking });
        } else if (block.type === 'text') {
          send({ type: 'message', msgId: getOrMintBlockMsgId(blockMsgIds, idx), msgType: 'text', content: block.text });
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
              send({ type: 'message', msgId: mintMsgId(), msgType: 'plan', content: md });
            }
          } else if (block.name === 'ExitPlanMode') {
            const plan = (block.input as any)?.plan;
            if (typeof plan === 'string') {
              send({ type: 'message', msgId: mintMsgId(), msgType: 'plan', content: plan });
            }
          }
        }
      });
      // DON'T clear blockMsgIds here. The next assistant message's own
      // `message_start` stream event is the authoritative boundary that
      // resets both the map and lastBlockStartIdx. Clearing on tool_result
      // was too eager — observed cases where SDK emits one more partial
      // assistant for the already-finished turn after tool_result.
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
      // `message_start` = boundary between two logical assistant messages.
      // SDK reuses block indices (0, 1, ...) for each new assistant message,
      // so we MUST clear the per-index → msgId map here. Prior approach
      // (clear-on-tool_result) was too eager: with `includePartialMessages:
      // true` the SDK can emit one more partial assistant for the
      // already-finished turn after tool_result has been delivered (rare,
      // observed empirically), which then re-mints msgIds for the same
      // text content → duplicate "Claude said the same thing twice" entries
      // in the timeline. message_start is the SDK's own authoritative
      // boundary signal — no heuristic, no edge cases.
      if (event?.type === 'message_start') {
        blockMsgIds.byIndex.clear();
        blockMsgIds.lastBlockStartIdx = -1;
        break;
      }
      // `content_block_start` tracks the highest seen index (used to anchor
      // assistant-emit position → absolute index), and mints a msgId for
      // text/thinking blocks. The SDK can re-fire content_block_start
      // mid-turn for the SAME logical block (observed quirk); we KEEP the
      // existing msgId so the renderer entry already streaming under it
      // doesn't orphan. tool_use blocks don't need a msgId but DO need to
      // bump lastBlockStartIdx so subsequent assistant emits align.
      if (event?.type === 'content_block_start' && typeof event.index === 'number') {
        if (event.index > blockMsgIds.lastBlockStartIdx) {
          blockMsgIds.lastBlockStartIdx = event.index;
        }
        const bt = event.content_block?.type;
        if (bt === 'text' || bt === 'thinking') {
          if (!blockMsgIds.byIndex.has(event.index)) {
            blockMsgIds.byIndex.set(event.index, mintMsgId());
          }
        }
        break;
      }
      if (event?.type === 'content_block_delta' && event.delta && typeof event.index === 'number') {
        const delta = event.delta;
        // Defensive: if we somehow missed content_block_start (SDK quirk),
        // lazily mint so the chunk still has an id.
        const msgId = getOrMintBlockMsgId(blockMsgIds, event.index);
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
          send({ type: 'stream', msgId, streamType: 'text', content: delta.text });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
          send({ type: 'stream', msgId, streamType: 'thinking', content: delta.thinking });
        }
      }
      break;
    }
    case 'user': {
      if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if ((block as any).type === 'tool_result') {
            const raw = (block as any).content;
            const content = extractToolResultText(raw);
            emitClaudeToolResult(send, (block as any).tool_use_id, content, (block as any).is_error === true);
          }
        }
        // No blockMsgIds clear here — the next assistant message's own
        // `message_start` stream event handles that boundary. See the
        // stream_event case for the rationale (eager clear-on-tool_result
        // mis-fires on late partial assistant emits).
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
