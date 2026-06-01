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

  // Claude is per-call by SDK design (model / effort / permissionMode flow
  // in via QueryInput each turn). These closure values exist to let the
  // /model /effort /permission slash handlers broadcast updated capabilities
  // immediately — without them, the renderer's status bar wouldn't know the
  // new pref took effect until the next SDK init event reported it.
  // gatherCapabilities() seeds them from the renderer's intent on reconnect.
  let currentModel: string | undefined;
  let currentEffort: string | undefined;
  let currentPermissionMode: string | undefined;

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

  function buildCapabilities(customModels?: ProviderModel[]): ProviderCapabilities {
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
      ...(currentModel ? { currentModel } : {}),
      ...(currentEffort ? { currentEffort } : {}),
      ...(currentPermissionMode ? { currentPermissionMode } : {}),
    };
  }

  return {
    async gatherCapabilities(
      cwd: string,
      _sessionId?: string,
      customModels?: ProviderModel[],
      intent?: { model?: string; effort?: string; permissionMode?: string },
    ): Promise<ProviderCapabilities> {
      // Seed closures from renderer's saved intent so /model /effort /permission
      // slash handlers can re-broadcast capabilities with the right current*.
      // Per-call QueryInput.{model,effort,permissionMode} still drives the
      // actual SDK behavior; closures are renderer-facing bookkeeping only.
      await ensureInit(cwd);
      if (intent?.model) currentModel = intent.model;
      if (intent?.effort) currentEffort = intent.effort;
      if (intent?.permissionMode) currentPermissionMode = intent.permissionMode;
      return buildCapabilities(customModels);
    },

    setModel(model: string) {
      // Per-call options.model wins on the next query; we just track for
      // capabilities broadcasts so renderer's status bar reflects the
      // current intent immediately.
      currentModel = model;
      currentSend?.({ type: 'capabilities', ...buildCapabilities() });
    },

    setEffort(effort: string) {
      currentEffort = effort;
      currentSend?.({ type: 'capabilities', ...buildCapabilities() });
    },

    setPermissionMode(mode: string) {
      currentPermissionMode = mode;
      currentSend?.({ type: 'capabilities', ...buildCapabilities() });
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
      // /model /effort /permission with args: intercept entirely. Claude has
      // no SDK validation point (per-call options), so we just record the
      // change in closure + re-broadcast capabilities so the renderer's
      // status bar + capability-driven persist see the new value immediately.
      // No SDK iteration runs for these — emit a fold_markdown reply and a
      // single idle status so the turn closes cleanly.
      if (slash && (slash.cmd === 'model' || slash.cmd === 'effort' || slash.cmd === 'permission')) {
        const msgId = mintSlashMsgId();
        const label = `/${slash.cmd}`;
        send({ type: 'status', state: 'streaming' });
        if (!slash.args) {
          send({
            type: 'message', msgId, msgType: 'fold_markdown', label,
            errorMessage: `Usage: /${slash.cmd} <value>`,
          });
          send({ type: 'status', state: 'idle' });
          return;
        }
        if (slash.cmd === 'model') currentModel = slash.args;
        else if (slash.cmd === 'effort') currentEffort = slash.args;
        else currentPermissionMode = slash.args;
        send({ type: 'capabilities', ...buildCapabilities() });
        send({
          type: 'message', msgId, msgType: 'fold_markdown', label,
          body: {
            content: slash.cmd === 'model'
              ? `Model set to **${slash.args}** (applies on next query)`
              : slash.cmd === 'effort'
                ? `Reasoning effort set to **${slash.args}** (applies on next query)`
                : `Permission mode set to **${slash.args}** (applies on next query)`,
          },
        });
        send({ type: 'status', state: 'idle' });
        return;
      }
      if (slash?.cmd === 'clear') {
        send({ type: 'plan', content: '' });
        inflightToolUses.clear();
        tasks.clear();
        pendingTaskCreates.clear();
        pendingTaskLists.clear();
        lastSessionId = null;
        send({ type: 'context_patch', patch: { lastSdkSessionId: null } });
        // Fall through — SDK still handles the actual /clear semantics.
      }
      let pendingCompactMsgId: string | null = null;
      if (slash?.cmd === 'compact') {
        pendingCompactMsgId = mintSlashMsgId();
        send({
          type: 'message', msgId: pendingCompactMsgId, msgType: 'fold_markdown',
          label: '/compact',
        });
        // Whole compact turn is critical — stop() silently no-ops until done.
        stoppable = false;
      }

      try {
        for await (const sdkMsg of activeQuery) {
          if ('session_id' in sdkMsg && sdkMsg.session_id) {
            lastSessionId = sdkMsg.session_id as string;
          }

          // /compact completion detection — listen for status with compact_result.
          // SDK 也會發 'compact_boundary' 帶 pre/post token，但 post_tokens 是
          // optional（壓縮完還沒實際送 model 算不出來），顯示 'pre → ?' 沒意義，
          // duration_ms 也常缺。直接吃 status.compact_result 當 terminal flag，
          // 顯示 'Compact completed' / 'Compact failed' 就好；要看 context 變化
          // 使用者本來就能從 status bar 的 context% 觀察。
          if (pendingCompactMsgId && sdkMsg.type === 'system') {
            const subtype = (sdkMsg as any).subtype;
            if (subtype === 'status' && (sdkMsg as any).compact_result) {
              const result = (sdkMsg as any).compact_result as 'success' | 'failed';
              if (result === 'success') {
                send({
                  type: 'message', msgId: pendingCompactMsgId, msgType: 'fold_markdown',
                  label: '/compact',
                  body: { content: 'Compact completed' },
                });
              } else {
                const errMsg = (sdkMsg as any).compact_error ?? 'Compaction failed';
                send({
                  type: 'message', msgId: pendingCompactMsgId, msgType: 'fold_markdown',
                  label: '/compact',
                  errorMessage: `Compact failed: ${errMsg}`,
                });
              }
              pendingCompactMsgId = null;
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
            type: 'message', msgId: pendingCompactMsgId, msgType: 'fold_markdown',
            label: '/compact',
            errorMessage: 'Compaction did not complete',
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
 * Plan-panel task mirror (replaces TodoWrite mirror as of SDK 0.3.142).
 *
 * Wire protocol to renderer is unchanged: still `{type:'plan', content:markdown}`.
 * Renderer is oblivious to task ids, TaskCreate vs TaskUpdate, etc.
 *
 * State machine:
 *   - TaskCreate `tool_use` → input has no id (assigned by SDK). Stash to
 *     pendingTaskCreates keyed by tool_use_id; wait for tool_result.
 *   - TaskCreate `tool_result` → JSON.parse output to extract task.id;
 *     promote pending → tasks Map; re-render plan.
 *   - TaskUpdate `tool_use` → input has taskId. Mutate tasks Map directly
 *     (optimistic, no tool_result wait). Next TaskList reconciles drift.
 *   - TaskList `tool_result` → snapshot is server ground truth; reconcile
 *     local Map (add missing, remove orphans, sync status).
 *   - `status: 'deleted'` on TaskUpdate is the only path that removes a
 *     task; `completed` stays in the list (rendered as `- [x]`).
 *
 * See .agent/features/sdk-upgrade-0.3.md for the rationale and design log.
 */
type TaskRecord = {
  subject: string;
  description: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
};
const tasks = new Map<string, TaskRecord>();
const pendingTaskCreates = new Map<string, Omit<TaskRecord, 'status'>>();
// Track outstanding TaskList tool_use ids so we can recognize matching
// tool_result content and only run parseTaskListOutput on candidates we know
// should be TaskList results. Without this, the parser would be used as a
// content sniffer (parse-or-null as detector) and we couldn't distinguish
// "this isn't TaskList" from "this IS TaskList but format changed" — the
// latter being a real bug worth logging.
const pendingTaskLists = new Set<string>();

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

/**
 * Parse `TaskCreate` tool_result to extract the SDK-assigned task id.
 *
 * Type def in `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` claims
 * `{ task: { id, subject } }`, but the actual wire content (verified empirically
 * on SDK 0.3.159 with model claude-opus-4-8) is human-readable text:
 *
 *   "Task #1 created successfully: Run typecheck"
 *
 * The `#N` integer is the taskId — TaskUpdate's `taskId` input matches it
 * verbatim (`"1"`, `"2"`, ...). Type-def-vs-runtime mismatch is documented
 * in `.agent/GOTCHAS.md`.
 *
 * Falls back to JSON shape just in case some flow returns the documented
 * structured form. Returns null when neither matches; caller drops the
 * pending entry and lets the next TaskList reconcile.
 */
export function parseTaskCreateOutput(content: string): string | null {
  // Wire format (observed): "Task #N created successfully: <subject>"
  const m = content.match(/^Task\s+#(\d+)\s+created\s+successfully/i);
  if (m) return m[1];
  // Documented JSON shape — kept as defensive fallback.
  try {
    const parsed = JSON.parse(content) as { task?: { id?: string | number } };
    const id = parsed?.task?.id;
    if (id != null) return String(id);
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Parse `TaskList` tool_result. Output shape:
 *   `{ tasks: Array<{ id, subject, status, owner? }> }`
 * Description and activeForm are NOT in TaskListOutput, so reconcile leaves
 * those fields empty when filling from a snapshot.
 */
export function parseTaskListOutput(content: string): Array<{
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
}> | null {
  try {
    const parsed = JSON.parse(content) as {
      tasks?: Array<{ id?: string; subject?: string; status?: string }>;
    };
    if (!Array.isArray(parsed?.tasks)) return null;
    const VALID_STATUS = new Set(['pending', 'in_progress', 'completed']);
    const out: Array<{ id: string; subject: string; status: TaskRecord['status'] }> = [];
    for (const t of parsed.tasks) {
      if (typeof t?.id !== 'string' || typeof t?.subject !== 'string') continue;
      if (typeof t?.status !== 'string' || !VALID_STATUS.has(t.status)) continue;
      out.push({ id: t.id, subject: t.subject, status: t.status as TaskRecord['status'] });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Render the tasks Map as a markdown checklist and emit to renderer as a
 * `plan` event. Renderer doesn't change; this replaces the old TodoWrite
 * snapshot path with the same wire shape.
 *
 *   pending      → `- [ ] subject`
 *   in_progress  → `- [~] activeForm` (or subject if activeForm absent)
 *   completed    → `- [x] subject`
 *
 * Insertion order of the Map drives row order — matches the order Agent
 * created tasks, which matches user mental model of "plan steps".
 */
export function renderPlan(send: SendFn, taskMap: Map<string, TaskRecord>) {
  const md = Array.from(taskMap.values()).map((t) => {
    if (t.status === 'completed') return `- [x] ${t.subject}`;
    if (t.status === 'in_progress') return `- [~] ${t.activeForm ?? t.subject}`;
    return `- [ ] ${t.subject}`;
  }).join('\n');
  send({ type: 'plan', content: md });
}

/**
 * Apply a TaskList snapshot to the local Map as drift-correction.
 *
 * Snapshot is server ground truth; possible local-vs-server divergences:
 *   - Local has id missing from snapshot → task deleted server-side, drop locally
 *   - Snapshot has id missing locally → resume-session or we missed a create,
 *     add with empty description/activeForm (TaskListOutput doesn't carry them)
 *   - Both have id but different status/subject → trust snapshot
 *
 * Always re-emits plan after applying so renderer sees the corrected state.
 */
export function reconcileTasks(
  taskMap: Map<string, TaskRecord>,
  snapshot: Array<{ id: string; subject: string; status: TaskRecord['status'] }>,
  send: SendFn,
) {
  const snapshotIds = new Set(snapshot.map((t) => t.id));
  for (const id of Array.from(taskMap.keys())) {
    if (!snapshotIds.has(id)) taskMap.delete(id);
  }
  for (const t of snapshot) {
    const existing = taskMap.get(t.id);
    if (existing) {
      taskMap.set(t.id, { ...existing, subject: t.subject, status: t.status });
    } else {
      taskMap.set(t.id, { subject: t.subject, description: '', status: t.status });
    }
  }
  renderPlan(send, taskMap);
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

/** Translate a Claude SDK `tool_use` block into a canonical fold_* card.
 *  Edit → fold_diff, Write → fold_code (raw add), other tools → fold_code. */
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
        type: 'message', msgId: block.id, msgType: 'fold_diff',
        label: 'Edit',
        subtitle: stripCwd(input.file_path, cwd),
      });
      return;
    }
    // Malformed Edit — fall through to generic fold_code so we don't drop it.
  }
  if (block.name === 'Write') {
    const input = block.input as { file_path?: string; content?: string };
    if (typeof input.file_path === 'string' && typeof input.content === 'string') {
      inflightToolUses.set(block.id, {
        kind: 'file_edit', filePath: input.file_path, content: input.content,
      });
      send({
        type: 'message', msgId: block.id, msgType: 'fold_code',
        label: 'Write',
        subtitle: stripCwd(input.file_path, cwd),
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
    type: 'message', msgId: block.id, msgType: 'fold_code',
    label: block.name,
    subtitle: input,
  });
}

/** Re-emit the original fold_diff/fold_code card with body/errorMessage
 *  populated. Pending → completed upsert (same msgId). */
function emitClaudeToolResult(
  send: SendFn,
  toolUseId: string,
  content: string,
  isError: boolean,
  cwd: string,
): void {
  const entry = inflightToolUses.get(toolUseId);
  if (!entry) return;
  inflightToolUses.delete(toolUseId);
  if (entry.kind === 'file_edit') {
    if (entry.diff) {
      // Edit — fold_diff. Success → diff body; failure → errorMessage, no body
      // (renderer skips body on Edit failure anyway; agent typically retries).
      send({
        type: 'message', msgId: toolUseId, msgType: 'fold_diff',
        label: 'Edit',
        subtitle: stripCwd(entry.filePath, cwd),
        ...(isError ? { errorMessage: content } : { body: { diff: entry.diff } }),
      });
    } else {
      // Write — fold_code with the new content as the body. On failure, attach
      // body when we have content (so the user sees what was attempted).
      send({
        type: 'message', msgId: toolUseId, msgType: 'fold_code',
        label: 'Write',
        subtitle: stripCwd(entry.filePath, cwd),
        ...(entry.content !== undefined ? { body: { content: entry.content } } : {}),
        ...(isError ? { errorMessage: content } : {}),
      });
    }
  } else {
    // AskUserQuestion special case: our intercept (canUseTool deny + smuggled
    // JSON answer) returns is_error:true on the wire even when the user
    // answered successfully. SDK 0.3.x now passes that through to the renderer
    // (0.2.x swallowed it). Suppress the red "Tool returned an error" banner
    // for this tool only — the model receives the answer JSON regardless and
    // continues the conversation normally.
    const suppressError = entry.toolName === 'AskUserQuestion';
    send({
      type: 'message', msgId: toolUseId, msgType: 'fold_code',
      label: entry.toolName,
      subtitle: entry.input,
      ...(isError && !suppressError
        ? { body: { content }, errorMessage: 'Tool returned an error' }
        : { body: { content } }),
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
          send({
            type: 'message', msgId: getOrMintBlockMsgId(blockMsgIds, idx), msgType: 'fold_text',
            label: 'Thinking',
            body: { content: block.thinking, tone: 'muted' },
          });
        } else if (block.type === 'text') {
          send({
            type: 'message', msgId: getOrMintBlockMsgId(blockMsgIds, idx), msgType: 'reply',
            content: block.text,
          });
        } else if (block.type === 'tool_use') {
          emitClaudeToolUse(send, { id: block.id, name: block.name, input: block.input as Record<string, unknown> }, cwd);
          // Mirror plan-style tools into the sticky panel for parity with Copilot's plan API.
          // ExitPlanMode: initial plan submission.
          // TaskCreate / TaskUpdate: ongoing task list (replaces TodoWrite as of SDK 0.3.142).
          if (block.name === 'TaskCreate') {
            // Input has no id (assigned by SDK in tool_result). Stash and wait.
            const i = block.input as { subject?: string; description?: string; activeForm?: string };
            if (typeof i?.subject === 'string' && typeof i?.description === 'string') {
              pendingTaskCreates.set(block.id, {
                subject: i.subject,
                description: i.description,
                activeForm: i.activeForm,
              });
            }
          } else if (block.name === 'TaskUpdate') {
            // Input carries taskId; mutate optimistically. Next TaskList reconciles.
            const i = block.input as {
              taskId?: string;
              subject?: string;
              description?: string;
              activeForm?: string;
              status?: 'pending' | 'in_progress' | 'completed' | 'deleted';
            };
            if (typeof i?.taskId === 'string') {
              if (i.status === 'deleted') {
                tasks.delete(i.taskId);
                renderPlan(send, tasks);
              } else {
                const existing = tasks.get(i.taskId);
                if (existing) {
                  tasks.set(i.taskId, {
                    ...existing,
                    ...(i.subject !== undefined && { subject: i.subject }),
                    ...(i.description !== undefined && { description: i.description }),
                    ...(i.activeForm !== undefined && { activeForm: i.activeForm }),
                    ...(i.status !== undefined && { status: i.status }),
                  });
                  renderPlan(send, tasks);
                }
                // Unknown taskId: TaskUpdate references a task we haven't seen
                // Create for (likely resume-session). Ignore; TaskList reconcile
                // will recover the missing task.
              }
            }
          } else if (block.name === 'TaskList') {
            // Register so tool_result handler runs parseTaskListOutput on the
            // matching reply. Without this we'd have to parse-sniff every
            // tool_result, conflating "not TaskList" with "TaskList parse fail".
            pendingTaskLists.add(block.id);
          } else if (block.name === 'ExitPlanMode') {
            const plan = (block.input as any)?.plan;
            if (typeof plan === 'string') {
              send({ type: 'plan', content: plan });
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
            const toolUseId = (block as any).tool_use_id;
            const isError = (block as any).is_error === true;

            // TaskCreate completion: promote pending → tasks Map using
            // server-assigned id from the result payload.
            if (!isError && pendingTaskCreates.has(toolUseId)) {
              const pending = pendingTaskCreates.get(toolUseId)!;
              pendingTaskCreates.delete(toolUseId);
              const taskId = parseTaskCreateOutput(content);
              if (taskId) {
                tasks.set(taskId, { ...pending, status: 'pending' });
                renderPlan(send, tasks);
              } else {
                // Parser failed on a tool_result we KNOW is TaskCreate — SDK
                // wire format likely changed. Drops the task from the plan
                // panel; next TaskList reconcile can recover. Log the format
                // so we know what to fix.
                console.error('[claude] TaskCreate result parse failed; format may have changed', { contentPreview: content.slice(0, 300) });
              }
            }

            // TaskList output: reconcile local Map against server ground truth.
            // Only attempt for tool_use_ids we registered as TaskList.
            if (!isError && pendingTaskLists.has(toolUseId)) {
              pendingTaskLists.delete(toolUseId);
              const snapshot = parseTaskListOutput(content);
              if (snapshot) {
                reconcileTasks(tasks, snapshot, send);
              } else {
                console.error('[claude] TaskList result parse failed; format may have changed', { contentPreview: content.slice(0, 300) });
              }
            }

            emitClaudeToolResult(send, toolUseId, content, isError, cwd);
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
