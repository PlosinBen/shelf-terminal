import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query, Options, SDKMessage, CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { QueryInput, SendFn, ServerBackend, ProviderCapabilities, StatusSegment, PickerResolvePayload } from '../types';
import { severityFromUtilization, pickPermissionModes, pickEffortLevels } from '../types';
import { parseSlashPrefix } from '@shared/slash-prefix';
import { formatConfigAck, type ConfigEditKey } from '@shared/config-ack';
import type { ProviderModel } from '@shared/types';
import { stripCwd } from '../shared';
import {
  rateLimitInfoToSegment,
  askUserQuestionToPrompts,
  buildAskUserQuestionAnswerJson,
  shouldAdoptResolvedModel,
  mergeClaudeModels,
  extractToolResultText,
  stripToolErrorWrapper,
  parseTaskCreateOutput,
  parseTaskListOutput,
  renderPlan,
  reconcileTasks,
  formatClaudeToolInput,
  type TaskRecord,
} from './helpers';

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


type PermissionResult =
  | { behavior: 'allow'; scope?: 'once' | 'session' }
  | { behavior: 'deny'; message?: string };

const CLAUDE_AUTH_METHOD = {
  kind: 'sdk-managed' as const,
  // Option A: the user signs in ON the remote host in a real terminal — the
  // credential is written to the remote's own ~/.claude and NEVER crosses
  // machines. We deliberately don't inject the deployed binary path: `claude`
  // reads credentials by home-dir, not by binary-dir, so a plain `claude login`
  // is correct regardless of which claude binary is invoked. On headless hosts
  // (SSH/container/WSL) the CLI falls back to a paste-the-code flow.
  instructions: [
    { label: 'Run this in a terminal on the remote host, then click Retry', command: 'claude login' },
  ],
};

/**
 * Tri-state result of the tab-open auth probe (ensureInit).
 *  - 'authed'      SDK reached `system/init` — credentials are valid.
 *  - 'auth-failed' a structured auth-failure frame arrived — show AuthPane.
 *  - 'error'       transient/unknown (timeout, non-auth error) — do NOT block
 *                  the pane; the user falls through to chat and any real auth
 *                  problem re-surfaces mid-turn (see query()).
 */
export type AuthOutcome = 'authed' | 'auth-failed' | 'error';

/**
 * Hang guard for the auth probe. An unauthenticated CLI may emit neither an
 * `init` nor an `auth_status` failure; without a bound the probe (and tab-open)
 * could hang forever. Kept under remote.ts's 30s capabilities RPC timeout so we
 * always resolve before that fires its empty-caps fallback.
 */
const AUTH_PROBE_TIMEOUT_MS = 20_000;

/**
 * Structured (NOT string-matched) detection of a Claude auth failure in the SDK
 * message stream. Only these exact signals count as "not signed in":
 *  - SDKAuthStatusMessage settled to a failure (isAuthenticating:false + error)
 *  - SDKAssistantMessage.error of the two auth members of SDKAssistantMessageError
 * rate_limit / server_error / transient isAuthenticating:true are deliberately
 * NOT treated as auth failures, so we never falsely take over the pane.
 */
export function isClaudeAuthFailure(msg: any): boolean {
  if (msg?.type === 'auth_status' && msg.isAuthenticating === false && msg.error) {
    return true;
  }
  if (msg?.type === 'assistant'
    && (msg.error === 'authentication_failed' || msg.error === 'oauth_org_not_allowed')) {
    return true;
  }
  return false;
}

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
    // R1 self-contained remote deploy: the Claude binary is shipped next to
    // index.mjs in the versioned deploy root, so __dirname/claude is it.
    resolve(__dirname, 'claude'),
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
  let initPromise: Promise<AuthOutcome> | null = null;
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

  /**
   * Probe the authenticated account via the SDK control channel. `system/init`
   * arrives even when logged out, so this is the real auth verdict. A populated
   * AccountInfo (any credential indicator) → authed; an empty/absent one →
   * auth-failed; a control-channel throw → 'error' (unknown, don't block).
   */
  async function probeAccount(gen: Query): Promise<AuthOutcome> {
    const TIMEOUT = Symbol('timeout');
    let timer: NodeJS.Timeout | undefined;
    try {
      // accountInfo resolves fast even when logged out (verified), so a short
      // race only guards a pathological hang.
      const info = await Promise.race([
        gen.accountInfo(),
        new Promise<typeof TIMEOUT>((res) => { timer = setTimeout(() => res(TIMEOUT), 8000); }),
      ]);
      if (info === TIMEOUT) return 'error';
      const a = info as any;
      // Logged-out accountInfo returns `{ tokenSource:'none', apiProvider:'firstParty' }`
      // (verified against a real unauthenticated claude). So `apiProvider` is
      // NOT an auth indicator, and `tokenSource` must be present AND not 'none'.
      // A real credential source (oauth/apiKey/...), an email, or an apiKeySource
      // means signed in.
      const authed = !!(a && (a.email || a.apiKeySource || (a.tokenSource && a.tokenSource !== 'none')));
      return authed ? 'authed' : 'auth-failed';
    } catch {
      // A control-channel throw is ambiguous — treat as unknown, not a definite
      // logout, so we don't lock out an authed user on a transient error.
      return 'error';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function ensureInit(cwd: string): Promise<AuthOutcome> {
    if (cache.models && cache.commands) return Promise.resolve('authed');
    if (initPromise) return initPromise;
    initPromise = (async (): Promise<AuthOutcome> => {
      const warmupAbort = new AbortController();
      // Hang guard — see AUTH_PROBE_TIMEOUT_MS. A logged-out CLI may emit
      // neither `init` nor an auth_status failure; bound the wait so tab-open
      // can't hang. Timeout → 'error' (unknown), which does NOT block the pane.
      let timedOut = false;
      const guard = setTimeout(() => { timedOut = true; warmupAbort.abort(); }, AUTH_PROBE_TIMEOUT_MS);
      let outcome: AuthOutcome = 'error';
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
          // Auth failure may surface as a structured frame before init.
          if (isClaudeAuthFailure(msg)) {
            outcome = 'auth-failed';
            warmupAbort.abort();
            break;
          }
          if (msg.type === 'system' && msg.subtype === 'init') {
            const [models, commands] = await Promise.all([
              generator.supportedModels().catch((err) => {
                console.error('[claude] supportedModels() failed; model picker will be empty', err?.message ?? err);
                return [];
              }),
              generator.supportedCommands().catch((err) => {
                console.error('[claude] supportedCommands() failed; slash picker will be empty', err?.message ?? err);
                return [];
              }),
            ]);
            cache.models = models;
            cache.commands = commands;
            // system/init alone does NOT prove auth — the CLI inits a session
            // without credentials; auth is only validated on a real call. Probe
            // the account explicitly via the control channel.
            outcome = await probeAccount(generator);
            // Never leave caps cached on a non-authed outcome, or the top-of-
            // function short-circuit would wrongly report 'authed' next time.
            if (outcome !== 'authed') { cache.models = undefined; cache.commands = undefined; }
            warmupAbort.abort();
            break;
          }
        }
      } catch (err: any) {
        // warmupAbort.abort() throws AbortError on every break path (success /
        // auth-failed / timeout) — expected. Only a non-abort error is a real
        // failure; keep it as 'error' so we don't falsely block the pane.
        if (err?.name !== 'AbortError') {
          console.error('[claude] warmup loop unexpected error', err?.message ?? err);
          outcome = 'error';
        }
      } finally {
        clearTimeout(guard);
      }
      if (timedOut) {
        console.error('[claude] auth probe timed out; treating as unknown (not blocking)');
        outcome = 'error';
      }
      return outcome;
    })();
    // Memoize ONLY a successful probe (cache populated → top short-circuit). On
    // auth-failed / error, drop the memo so a later re-probe (checkAuth Retry,
    // or next gatherCapabilities) re-runs against the now-changed credential
    // state instead of returning the stale failure forever.
    const p = initPromise;
    p.then((o) => { if (o !== 'authed') initPromise = null; }, () => { initPromise = null; });
    return p;
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

  /**
   * Apply a config edit and emit the full turn lifecycle: set the closure
   * value, broadcast capabilities (drives renderer display + persist), and
   * render the change as a centered `system` divider (status transition, not
   * content). Single convergence point for BOTH entry points:
   *   - typed `/model X` slash (parsed in query())
   *   - structured config-edit turn (input.configEdit, from picker / status bar)
   * so the divider + capabilities come back identically regardless of how the
   * user triggered the change. Distinct from setModel/setEffort/etc., which are
   * the orchestrator's silent per-message pref-diff apply (no divider).
   */
  function applyConfigEdit(key: ConfigEditKey, value: string, send: SendFn) {
    send({ type: 'status', state: 'streaming' });
    if (key === 'model') currentModel = value;
    else if (key === 'effort') currentEffort = value;
    else currentPermissionMode = value;
    send({ type: 'capabilities', ...buildCapabilities() });
    send({ type: 'message', msgId: mintSlashMsgId(), msgType: 'system', content: formatConfigAck(key, value) });
    send({ type: 'status', state: 'idle' });
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
      const outcome = await ensureInit(cwd);
      if (intent?.model) currentModel = intent.model;
      if (intent?.effort) currentEffort = intent.effort;
      if (intent?.permissionMode) currentPermissionMode = intent.permissionMode;
      // authRequired ONLY on a definitive auth-failure. 'error' (timeout /
      // unknown) leaves it false so a slow remote isn't mistaken for logged-out.
      return { ...buildCapabilities(customModels), authRequired: outcome === 'auth-failed' };
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

      // Config-edit turn (picker / status-bar): structured key+value, no prompt,
      // no SDK query. Converges UI config edits onto applyConfigEdit — the same
      // path a typed /model slash takes below.
      if (input.configEdit) {
        applyConfigEdit(input.configEdit.key, input.configEdit.value, send);
        return;
      }

      // Slash interception MUST run BEFORE the SDK query is built/created below.
      // /model /effort /permission are provider-only config edits. If we let the
      // raw "/model opus" string become the SDK prompt, the bundled Claude Code
      // CLI interprets it natively and records it in the session — the NEXT turn
      // then resumes a session that "saw" /model opus and the model comments on
      // it. Intercept-and-return here keeps these slashes entirely out of the
      // SDK (and avoids building a never-consumed sdkQuery). /clear and /compact
      // intentionally fall through below — they need the real SDK turn.
      const slash = parseSlashPrefix(input.prompt);
      if (slash && (slash.cmd === 'model' || slash.cmd === 'effort' || slash.cmd === 'permission')) {
        // No-args normally never reaches here — InputZone intercepts optioned
        // slashes with no arg and opens a renderer-side picker instead. This is
        // a defensive fallback (renderer logic could change): surface a plain
        // error rather than silently swallowing the turn.
        if (!slash.args) {
          send({ type: 'status', state: 'streaming' });
          send({ type: 'message', msgId: mintSlashMsgId(), msgType: 'error', content: `Usage: /${slash.cmd} <value>` });
          send({ type: 'status', state: 'idle' });
          return;
        }
        // `/permission` slash → normalized key `permissionMode`.
        const key: ConfigEditKey = slash.cmd === 'permission' ? 'permissionMode' : slash.cmd;
        applyConfigEdit(key, slash.args, send);
        return;
      }

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

      // /clear and /compact need provider-side bookkeeping the SDK can't reach,
      // but unlike /model etc. they DO run a real SDK turn (fall through below).
      // `slash` was already parsed at the top of query() for the early-return
      // interception of /model /effort /permission.
      //   - `/clear`: reset in-memory lastSessionId + emit context_patch so
      //     persistence doesn't resurrect the dead session on next launch.
      //   - `/compact`: capture completion via SDKCompactBoundaryMessage +
      //     SDKStatusMessage and surface as a fold_markdown card.
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
          // ── Phase 0 spike (THROWAWAY — whole block reverted after World A/B) ──
          // Prints the post-`result` message sequence so we can tell whether
          // `result` precedes or follows background-task settle. See the
          // "Phase 0 — Spike" section of background-tasks.md.
          {
            const a = sdkMsg as any;
            console.error('[task-spike] msg ' + JSON.stringify({
              type: a.type,
              subtype: a.subtype,
              task_id: a.task_id,
              parent_tool_use_id: a.parent_tool_use_id,
              is_backgrounded: a.patch?.is_backgrounded,
              bg_tasks: Array.isArray(a.background_tasks) ? a.background_tasks.length : undefined,
            }));
          }

          if ('session_id' in sdkMsg && sdkMsg.session_id) {
            lastSessionId = sdkMsg.session_id as string;
          }

          // Mid-turn auth failure (e.g. credentials revoked / expired during a
          // session). Surface the same AuthPane takeover as the tab-open probe.
          // Mirrors copilot's query() auth_required emit. Structured detection
          // (isClaudeAuthFailure), provider passed explicitly so remote.ts
          // doesn't default it to 'copilot'.
          if (isClaudeAuthFailure(sdkMsg)) {
            send({ type: 'auth_required', provider: 'claude' });
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

          // Alias resolution → pin concrete model.
          //
          // supportedModels() returns the SDK's recommended aliases
          // (default/sonnet/haiku) — cached in cache.models. The rule:
          //   - intent IS one of those aliases → keep it (it tracks the
          //     recommendation; never overwrite with a concrete id, so the
          //     status bar shows a stable 'default' instead of flip-flopping
          //     to 'claude-opus-4-8' per turn and back to 'default' on restart)
          //   - intent is NOT a known alias (user pinned a specific model, e.g.
          //     via custom model id) → adopt the SDK's actual resolved model and
          //     re-emit capabilities so the status bar + project config reflect
          //     what actually ran (existing capabilities→persist path handles both).
          // Guarded on cache.models being populated so we never misclassify an
          // alias as "unknown" before warmup completes. See DECISIONS-agent #62.
          if (sdkMsg.type === 'assistant' && sdkMsg.parent_tool_use_id == null) {
            const resolved = sdkMsg.message?.model;
            if (shouldAdoptResolvedModel(resolved, currentModel, cache.models ?? [])) {
              currentModel = resolved;
              send({ type: 'capabilities', ...buildCapabilities() });
            }
          }
        }
        // ── Phase 0 spike (THROWAWAY — whole block reverted after World A/B) ──
        // Marks the point the SDK generator actually ends (for-await complete),
        // i.e. when query() currently resolves and unblocks sendChain. Compare
        // its timing vs the `result` line above. See background-tasks.md.
        console.error('[task-spike] generator ended (for-await complete)');
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
        } catch (err: any) {
          // SDK interrupt fail-loud, then fall back to AbortController so the
          // stop intent still resolves. Repeated occurrence means SDK interrupt
          // surface broke — we'd silently lose user-visible stop responsiveness.
          console.error('[claude] activeQuery.interrupt() failed; falling back to AbortController', err?.message ?? err);
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
  // Strip the SDK's <tool_use_error> wrapper once for all error branches below.
  // No-op on non-error content (and on AskUserQuestion's smuggled JSON, which
  // carries no wrapper).
  if (isError) content = stripToolErrorWrapper(content);
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
        // Model intentionally NOT sent here. The displayed model is driven by
        // the capabilities channel (currentModel), which carries the user's
        // intent — a recommended alias (default/sonnet/haiku) stays as-is, and
        // a user-pinned non-alias gets resolved to the concrete model via the
        // promotion logic in the query loop. Emitting the per-turn resolved
        // model here would clobber the alias display (flip-flop). See the
        // alias-resolution block in query() and DECISIONS-agent #62.
        send({
          type: 'status', state: 'streaming',
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
        // msg.model is the SDK-resolved concrete model (e.g. 'claude-opus-4-8[1m]'),
        // NOT the user's selected alias. Don't send it — see the per-turn status
        // emit above for why the model display is capabilities-driven only.
        send({ type: 'status', state: 'streaming', sessionId: msg.session_id });
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
