import { query as sdkQuery, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { Query, Options, SDKMessage, SDKUserMessage, CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { runBridgeTool, APP_SKILL_LIST_DESC, APP_SKILL_GET_DESC, APP_SKILL_CREATE_DESC, APP_SKILL_UPDATE_DESC, APP_SKILL_READ_FILE_DESC, APP_SKILL_WRITE_FILE_DESC, APP_SKILL_DELETE_FILE_DESC, WEB_FETCH_DESC, BROWSER_OPEN_DESC } from '../../app-tool-tools';
import { isWebFetchTool, WEB_FETCH_TOOL, isBrowserOpenTool, BROWSER_OPEN_TOOL } from '@shared/web-session';
import { serverLog } from '../../server-logger';
import { createRouterState, notePush, routeMessage } from './turn-router';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { resolve, join, dirname } from 'path';
import type { QueryInput, SendFn, ServerBackend, ProviderCapabilities, StatusSegment, PickerResolvePayload, ReapableTask } from '../types';
import { severityFromUtilization, pickPermissionModes, pickEffortLevels } from '../types';
import { parseSlashPrefix } from '@shared/slash-prefix';
import { formatConfigAck, type ConfigEditKey } from '@shared/config-ack';
import type { ProviderModel, NormalizedTask } from '@shared/types';
import { stripCwd, resolveSkillsPluginRoot } from '../shared';
import { loadProjectedMcpServers } from '../mcp-config';
import {
  formatClaudeMcpCard,
  formatClaudeSkillsCard,
  type ClaudeMcpServer,
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
  normalizeTaskMessage,
  isForegroundBashTaskStart,
  isSubagentTaskStart,
  pickSessionTasksDir,
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
  // /mcp /skills: provider-intercepted read-only listings (see query()). They
  // are NOT SDK-dispatchable (interactive-TUI-only) — Shelf prints the listing
  // itself from init-cached data. Listed here so they appear in autocomplete +
  // are dispatched (list ↔ dispatch must be paired — see the /help note above).
  { name: 'mcp', description: 'List loaded MCP servers' },
  { name: 'skills', description: 'List loaded skills' },
  // /help 尚未實作 provider-side dispatch — SDK 不會原生回 command list，
  // 若列在 autocomplete 上送出去只會被當成普通 prompt 餵給模型。實作前先註解。
  // { name: 'help', description: 'List available slash commands' },
];

// Command names that are NOT user skills — filtered out when deriving the
// `/skills` listing from supportedCommands() (which mixes built-ins + config
// slashes + custom commands + skills, with no way to tell them apart). What
// remains = user-added commands + skills.
const CLAUDE_NON_SKILL_COMMANDS = new Set([
  'clear', 'compact', 'context', 'usage', 'mcp', 'skills',
  'model', 'effort', 'permission', 'help',
]);


type PermissionResult =
  | { behavior: 'allow'; scope?: 'once' | 'session' }
  | { behavior: 'deny'; message?: string };

// The SDK's terminal signal for a completed `/compact`. Newer SDKs emit a
// `compact_boundary` system message (SDKCompactBoundaryMessage) once the
// compaction summary is spliced in; there is NO separate success/failed result
// message. A failed compaction simply never emits the boundary — the foreground
// turn ends and closeFrame's fallback surfaces the error. (The old
// `subtype: 'status'` + `compact_result` shape no longer exists, which is why
// every /compact used to report "Compaction did not complete".)
export function isCompactBoundary(msg: SDKMessage): boolean {
  return msg.type === 'system' && (msg as { subtype?: string }).subtype === 'compact_boundary';
}

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
 * Hang guard for the `/mcp` `/skills` cold-start probe (ensureLoadedContext).
 * Same rationale as AUTH_PROBE_TIMEOUT_MS — bound the wait so a stuck CLI can't
 * wedge a slash. Best-effort: on timeout the cache stays unset and the slash
 * reports a load failure rather than hanging.
 */
const LOADED_CONTEXT_PROBE_TIMEOUT_MS = 20_000;

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
  // Deliberately NOT setting `settingSources` — when omitted the SDK loads all
  // filesystem settings (user/project/local), so project-level config is read
  // natively: `.claude/skills`, CLAUDE.md, project settings. Native parity with
  // the raw CLI (PRODUCT.md #5). Do NOT pass `settingSources: []` (SDK isolation
  // mode) or project skills / CLAUDE.md silently stop loading.
} as const satisfies Partial<Options>;

// In-process MCP server exposing the app-level capability bridge tools (read
// ops). Built once (handlers are stateless → callMain). Merged into a session's
// `options.mcpServers`. The model sees `mcp__shelf__list_app_skills` etc.
let shelfMcpServer: ReturnType<typeof createSdkMcpServer> | null = null;
function getShelfMcpServer() {
  if (!shelfMcpServer) {
    shelfMcpServer = createSdkMcpServer({
      name: 'shelf',
      version: '1.0.0',
      tools: [
        tool('list_app_skills', APP_SKILL_LIST_DESC, {}, async () => {
          const { text } = await runBridgeTool('app_skill.list', {});
          return { content: [{ type: 'text' as const, text }] };
        }),
        tool('get_app_skill', APP_SKILL_GET_DESC, { name: z.string().describe('skill folder name from list_app_skills') }, async ({ name }) => {
          const { text, isError } = await runBridgeTool('app_skill.get', { name });
          return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
        }),
        tool('create_app_skill', APP_SKILL_CREATE_DESC, { content: z.string().describe('full SKILL.md (frontmatter name+description + body)') }, async ({ content }) => {
          const { text, isError } = await runBridgeTool('app_skill.create', { content });
          return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
        }),
        tool('update_app_skill', APP_SKILL_UPDATE_DESC, { name: z.string().describe('current skill folder name'), content: z.string().describe('full new SKILL.md') }, async ({ name, content }) => {
          const { text, isError } = await runBridgeTool('app_skill.update', { name, content });
          return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
        }),
        tool('read_app_skill_file', APP_SKILL_READ_FILE_DESC, { name: z.string().describe('skill folder name'), path: z.string().describe('folder-relative aux-file path from get_app_skill `files`') }, async ({ name, path }) => {
          const { text, isError } = await runBridgeTool('app_skill.read_file', { name, path });
          return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
        }),
        tool('write_app_skill_file', APP_SKILL_WRITE_FILE_DESC, { name: z.string().describe('skill folder name'), path: z.string().describe('folder-relative aux-file path (no leading slash, no ..)'), content: z.string().describe('file content') }, async ({ name, path, content }) => {
          const { text, isError } = await runBridgeTool('app_skill.write_file', { name, path, content });
          return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
        }),
        tool('delete_app_skill_file', APP_SKILL_DELETE_FILE_DESC, { name: z.string().describe('skill folder name'), path: z.string().describe('folder-relative aux-file path') }, async ({ name, path }) => {
          const { text, isError } = await runBridgeTool('app_skill.delete_file', { name, path });
          return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
        }),
        tool(WEB_FETCH_TOOL, WEB_FETCH_DESC, {
          url: z.string().describe('absolute http(s) URL of the internal service'),
          method: z.string().optional().describe('HTTP method (default GET)'),
          headers: z.record(z.string(), z.string()).optional().describe('extra request headers, e.g. {"kbn-xsrf":"true"}'),
          body: z.string().optional().describe('request body, e.g. a JSON query string'),
        }, async ({ url, method, headers, body }) => {
          const { text, isError } = await runBridgeTool('web.fetch', { url, method, headers, body });
          return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
        }),
        tool(BROWSER_OPEN_TOOL, BROWSER_OPEN_DESC, {
          url: z.string().describe('absolute http(s) URL to open in a visible Web tab for the user to log in'),
          reason: z.string().optional().describe('short explanation of why this page must be opened (shown in the approval popup)'),
        }, async ({ url, reason }) => {
          const { text, isError } = await runBridgeTool('web.open', { url, reason });
          return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
        }),
      ],
    });
  }
  return shelfMcpServer;
}

export function createClaudeBackend(): ServerBackend {
  // `/mcp` `/skills` hold RAW SDK results (not a normalized cross-provider type);
  // the card markdown is composed on read by formatClaude*Card. `undefined` =
  // not loaded yet.
  const cache: { models?: any[]; commands?: any[]; mcpServers?: ClaudeMcpServer[]; skills?: Array<{ name: string; description?: string }> } = {};
  let initPromise: Promise<AuthOutcome> | null = null;
  // In-flight dedup for ensureLoadedContext so concurrent /mcp + /skills (or a
  // double-tap) spin only one cold-start probe.
  let loadedContextWarm: Promise<void> | null = null;
  let lastSessionId: string | null = null;
  // The SDK's per-session task-output dir. Authoritatively set from the first
  // task_notification's output_file (its dirname); derived by globbing the
  // session id when no notification ever arrives (upstream delivery bug). Lets
  // readTaskOutput recover a task's output from `<tasksDir>/<id>.output` even
  // when the path-bearing notification was dropped. See pickSessionTasksDir.
  let tasksDir: string | undefined;

  /** Best-effort reconstruction of `tasksDir` from the SDK's
   *  `/tmp/claude-<uid>/<slug>/<session>/tasks` convention (POSIX-only; the
   *  agent-server's env lacks CLAUDE_CODE_TMPDIR). Globs the slug by session id. */
  function deriveTasksDir(sessionId: string | null): string | undefined {
    if (!sessionId || process.platform === 'win32' || typeof process.getuid !== 'function') return undefined;
    const base = `/tmp/claude-${process.getuid()}`;
    let slugs: string[];
    try { slugs = readdirSync(base); } catch { return undefined; }
    return pickSessionTasksDir(base, sessionId, slugs, existsSync);
  }

  const pendingPermissions = new Map<string, (result: PermissionResult) => void>();

  // Renderer-facing pref bookkeeping (Architecture B applies them via SDK
  // control methods — see setModel/setEffort/setPermissionMode). Seeded from
  // the renderer's intent on reconnect via gatherCapabilities().
  let currentModel: string | undefined;
  let currentEffort: string | undefined;
  let currentPermissionMode: string | undefined;

  // Non-cancellable critical-section flag (see Copilot's matching helper for
  // rationale). Wraps Claude's `/compact` turn so stop() silently no-ops
  // mid-compaction — interrupting half-way would leave the session in an
  // indeterminate compacted/un-compacted state.
  let stoppable = true;

  // Pending picker promises keyed by picker id (= AskUserQuestion toolUseID).
  const pendingPickers = new Map<string, (payload: PickerResolvePayload) => void>();

  // Set when permissionMode === 'bypassPermissions'. Read inside canUseTool so
  // bypass short-circuits non-AskUserQuestion tools without skipping the
  // AskUserQuestion intercept.
  let currentBypassMode = false;

  // ── Persistent streaming-input session (Architecture B) ──────────────────
  // ONE sdkQuery for the whole tab. A single consumer loop drains its
  // generator and the pure turn-router (turn-router.ts) attributes each
  // message to a foreground turn or a server (auto-resume) turn. Replaces the
  // old per-turn sdkQuery + detached-drain. See DECISIONS / streaming-input.
  // A user prompt waiting in the queue for its `system/init` to arrive. On init
  // it is turned into an active foreground TurnFrame (openForegroundFrame).
  interface ForegroundTurn {
    /** Turn-bound send (orchestrator already wrapped it with turnId+context). */
    send: SendFn;
    /** Idle-deduped wrapper over `send` (multiple idle emit sites per turn). */
    turnSend: SendFn;
    blockMsgIds: BlockMsgIdState;
    cwd: string;
    pendingCompactMsgId: string | null;
    /** Resolves this turn's `query()` promise (consumer calls on foreground result). */
    resolve: () => void;
  }
  // The active turn's unified representation. ONE content path (routeContent)
  // drives BOTH a user foreground turn and an SDK auto-resume (server) turn —
  // their only differences are DATA on this frame, not separate code paths.
  // Previously foreground/server had near-duplicate route*/start* fns; the copy
  // drifted (server forgot `user` tool_results → the "整排 tool 卡沒 result" bug).
  // See features/claude-content-turn-unify.
  interface TurnFrame {
    kind: 'foreground' | 'server';
    /** Content + status sink. FG: idle-deduped `turnSend`. Server: base send
     *  pre-stamped with `turnId` + `startsTurn` on its first message. */
    send: SendFn;
    blockMsgIds: BlockMsgIdState;
    /** FG: forward EVERY SDK message to processMessage (live stream deltas +
     *  the result's cost/usage). Server: only assistant/user + block-boundary
     *  stream_event (whole-reply delivery, no per-turn cost echo). */
    forwardAll: boolean;
    // ── foreground-only ──
    /** RAW (non-idle-deduped) session send — cost / context_patch / compact
     *  fallback / auth / model-alias emits that must bypass idle dedup. */
    rawSend?: SendFn;
    cwd?: string;
    pendingCompactMsgId?: string | null;
    /** Resolves this turn's `query()` promise (called at the foreground close). */
    resolve?: () => void;
  }
  interface Session {
    query: Query;
    abort: AbortController;
    pushUser: (content: SDKUserMessage['message']['content']) => void;
    closeInput: () => void;
  }
  let session: Session | null = null;
  let creatingSession: Promise<Session> | null = null;
  let sessionCwd = '';
  const pendingPush: ForegroundTurn[] = [];
  // The single active turn (foreground OR server). Turns are strictly serial
  // (turn-router.ts), so one slot suffices; the `activeCycles` counter below
  // tracks cardinality for busy/idle independently.
  let activeFrame: TurnFrame | null = null;
  const router = createRouterState();
  // ── Busy/idle as a single active-cycle COUNTER (see features/claude-content-turn-unify) ──
  // Every SDK turn opens with `init` and closes with `result` (spike-confirmed;
  // SDKResultMessage carries no per-turn id, so we COUNT rather than match). Busy
  // = counter > 0; idle is emitted ONLY when the counter drains to 0. This makes
  // foreground + auto-resume a single spinner signal and removes the old
  // per-turn idle bookkeeping + main-side background-tasks#6 suppression. A
  // COUNTER (not a single-slot flag) is correct whether turns are serial or
  // overlap. `clamp at 0` absorbs a stray `result` with no matching `init` (the
  // task-notification result after a background drain with no auto-resume prose).
  let activeCycles = 0;
  function noteCycleOpen() { activeCycles++; }
  /** Close one cycle; emit idle via `send` ONLY when the counter reaches 0. */
  function emitIdleIfSettled(send: SendFn) {
    activeCycles = Math.max(0, activeCycles - 1);
    if (activeCycles === 0) send({ type: 'status', state: 'idle' });
  }
  // Most-recent foreground turn's send — base for server turns (same session →
  // context-patch interception is correct) and out-of-turn capabilities emits.
  let lastTurnSend: SendFn | null = null;
  // For content the router drops with no active turn (drift): emit it session-
  // scoped via lastTurnSend rather than lose it. Status is suppressed there (no
  // turn to attribute), and content needs its OWN blockMsgIds (no turn's to use).
  // See turnId-scoping (Phase 3).
  const NOOP_SEND: SendFn = () => {};
  const driftBlockMsgIds = createBlockMsgIdState();

  /** The send fn to route an inbound permission/picker request to: the turn the
   *  SDK is currently working (the single active frame), else the most-recent
   *  session send. */
  const activeSend = (): SendFn | null => (activeFrame?.send ?? lastTurnSend);

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

    // web_fetch carries its OWN gate downstream (main handleAppTool: a generic,
    // provider-agnostic per-origin web-permission popup). Skip the provider tool
    // prompt here so the user isn't asked twice. The downstream gate runs even in
    // bypass mode (the tool still executes), so credential use stays authorized.
    if (isWebFetchTool(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    // browser_open likewise carries its OWN downstream gate (main handleAppTool:
    // a per-call Open/Deny popup, never remembered). Skip the provider tool
    // prompt so the user isn't asked twice; the downstream gate still runs
    // (even in bypass mode — the tool still executes).
    if (isBrowserOpenTool(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    // DIY bypass: SDK stays at 'default' permissionMode and our canUseTool
    // short-circuits to allow. Avoids SDK's `allowDangerouslySkipPermissions`
    // flag and keeps plan/acceptEdits SDK-native (those have non-trivial
    // built-in semantics worth keeping).
    if (currentBypassMode) {
      return { behavior: 'allow', updatedInput: input };
    }

    activeSend()?.({ type: 'permission_request', toolUseId, toolName, input });
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
      serverLog('debug', 'picker', 'preview content received, not rendered yet', sample);
    }

    activeSend()?.({ type: 'picker_request', id: toolUseId, prompts: mapped.prompts });

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
                serverLog('error', 'claude', 'supportedModels() failed; model picker will be empty', err?.message ?? err);
                return [];
              }),
              generator.supportedCommands().catch((err) => {
                serverLog('error', 'claude', 'supportedCommands() failed; slash picker will be empty', err?.message ?? err);
                return [];
              }),
            ]);
            cache.models = models;
            cache.commands = commands;
            // NOTE: /mcp /skills cache is NOT populated here. This warmup probe is
            // cwd-only (no `plugins` / in-process MCP), so it would MISS app-level
            // skills + the in-process `shelf` bridge. The accurate source is the
            // real persistent session — see refreshLoadedContext() (called from
            // its system/init in handleSdkMessage).
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
          serverLog('error', 'claude', 'warmup loop unexpected error', err?.message ?? err);
          outcome = 'error';
        }
      } finally {
        clearTimeout(guard);
      }
      if (timedOut) {
        serverLog('error', 'claude', 'auth probe timed out; treating as unknown (not blocking)');
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
    // No-op guard: submitting the value that's already live (re-picking the
    // selected model/effort/permission, or `/model <current>`) isn't a change —
    // don't flash a status cycle or drop a divider for something that didn't
    // move. On a config-edit turn no prior setter mutates the closure first, so
    // the closure still holds the true prior value here.
    const current = key === 'model' ? currentModel : key === 'effort' ? currentEffort : currentPermissionMode;
    if (value === current) return;
    send({ type: 'status', state: 'streaming' });
    if (key === 'model') currentModel = value;
    else if (key === 'effort') currentEffort = value;
    else currentPermissionMode = value;
    send({ type: 'capabilities', ...buildCapabilities() });
    send({ type: 'message', msgId: mintSlashMsgId(), msgType: 'system', content: formatConfigAck(key, value) });
    send({ type: 'status', state: 'idle' });
  }

  // ── Persistent-session machinery ────────────────────────────────────────

  /** Create the single long-lived streaming-input query + its consumer loop.
   *  Options snapshot the CURRENT prefs; mid-session changes go via control
   *  methods (model/permission) or a rebuild (effort). */
  function createSession(cwd: string, resume: string | undefined, appId: string | undefined): Session {
    const queue: SDKUserMessage[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    async function* inputStream(): AsyncGenerator<SDKUserMessage> {
      while (!closed) {
        if (queue.length) { yield queue.shift()!; continue; }
        await new Promise<void>((r) => { wake = r; });
      }
    }
    const abort = new AbortController();
    const options: Options = {
      ...CLAUDE_QUERY_DEFAULTS,
      abortController: abort,
      cwd,
      permissionMode: currentBypassMode ? 'default' : ((currentPermissionMode as Options['permissionMode']) ?? 'default'),
      canUseTool,
    };
    const resumeId = resume ?? lastSessionId ?? undefined;
    if (resumeId) options.resume = resumeId;
    if (currentModel) (options as any).model = currentModel;
    if (currentEffort) (options as any).effort = currentEffort;
    const skillsPluginRoot = resolveSkillsPluginRoot(appId);
    if (skillsPluginRoot) (options as any).plugins = [{ type: 'local', path: skillsPluginRoot }];
    // App-level user MCP servers (our blocks map 1:1 onto Claude's McpServerConfig
    // stdio/http shapes). Fail-loud: surface load problems, don't swallow. The
    // in-process `shelf` bridge is added LAST so a user-named "shelf" can't clobber
    // it. Native MCP is NOT in this map — the SDK loads it independently via
    // settingSources-omitted (raw-CLI parity, PRODUCT.md #5); app-level is additive.
    const userMcp = loadProjectedMcpServers(appId);
    for (const e of userMcp.errors) serverLog('warn', 'claude', `MCP config: ${e}`);
    (options as any).mcpServers = { ...userMcp.servers, shelf: getShelfMcpServer() };

    const q = sdkQuery({ prompt: inputStream(), options }) as Query;
    sessionCwd = cwd;
    const s: Session = {
      query: q,
      abort,
      pushUser: (content) => {
        queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
        wake?.(); wake = null;
      },
      closeInput: () => { closed = true; wake?.(); wake = null; },
    };
    void consume(q);
    return s;
  }

  function ensureSession(cwd: string, resume: string | undefined, appId: string | undefined): Session {
    if (!session) session = createSession(cwd, resume, appId);
    return session;
  }

  /** Drain the persistent generator forever, attributing each message to a
   *  turn via the pure router. */
  async function consume(q: Query) {
    try {
      for await (const msg of q) handleSdkMessage(msg);
    } catch (err: any) {
      if (err?.name !== 'AbortError') serverLog('error', 'claude', 'session consumer error:', err?.message ?? err);
    } finally {
      teardownTurns();
      if (session?.query === q) session = null;
    }
  }

  /**
   * Refresh the `/mcp` `/skills` listings from the REAL persistent session's
   * control methods (full options: plugins/app skills + in-process MCP + cwd).
   * Fire-and-forget from the session's system/init. Normalize ONCE here; the
   * slash handlers just read the cache. Refresh = reconnect (new session →
   * new init → re-run this). Best-effort — leaves the prior cache on failure.
   */
  async function refreshLoadedContext(): Promise<void> {
    const q = session?.query;
    if (!q) return;
    try {
      const [servers, commands] = await Promise.all([
        q.mcpServerStatus().catch(() => [] as any[]),
        q.supportedCommands().catch(() => [] as any[]),
      ]);
      cache.mcpServers = servers as ClaudeMcpServer[];
      cache.skills = commands as Array<{ name: string; description?: string }>;
    } catch (err: any) {
      serverLog('error', 'claude', 'refreshLoadedContext failed', err?.message ?? err);
    }
  }

  /**
   * Cold-start fill of the `/mcp` `/skills` cache when no real session exists yet
   * (user opened a tab and typed the slash before sending any message). The real
   * persistent session is streaming-input — it emits NO `system/init` until the
   * first user message is pushed, so `ensureSession()` alone can't warm the cache.
   * A string-prompt probe DOES init immediately (same trick as the auth warmup),
   * so we spin a throwaway one with the SAME full options as the real session
   * (plugins/app skills + in-process `shelf` MCP + cwd) — anything less would
   * under-report (the exact trap the auth warmup's cwd-only probe falls into) —
   * read the listings off its init, then abort it. Deliberately separate from the
   * auth warmup so loading the MCP/skills world never fate-shares with the auth
   * verdict (a slow/broken MCP must not block tab-open). Idempotent + deduped:
   * no-op once the cache is filled (e.g. by the real session's refreshLoadedContext).
   */
  function ensureLoadedContext(cwd: string, appId: string | undefined): Promise<void> {
    if (cache.mcpServers !== undefined && cache.skills !== undefined) return Promise.resolve();
    if (loadedContextWarm) return loadedContextWarm;
    loadedContextWarm = (async () => {
      const abort = new AbortController();
      const guard = setTimeout(() => abort.abort(), LOADED_CONTEXT_PROBE_TIMEOUT_MS);
      try {
        const options: Options = {
          ...CLAUDE_QUERY_DEFAULTS,
          cwd,
          // Read-only probe — aborted at init before any turn runs.
          permissionMode: 'plan',
          abortController: abort,
        };
        const skillsPluginRoot = resolveSkillsPluginRoot(appId);
        if (skillsPluginRoot) (options as any).plugins = [{ type: 'local', path: skillsPluginRoot }];
        // Same merge as createSession so the cold-start /mcp card lists user
        // servers too (shelf last, can't be clobbered).
        (options as any).mcpServers = { ...loadProjectedMcpServers(appId).servers, shelf: getShelfMcpServer() };
        const gen = sdkQuery({ prompt: ' ', options }) as Query;
        for await (const msg of gen) {
          if (msg.type === 'system' && (msg as any).subtype === 'init') {
            const [servers, commands] = await Promise.all([
              gen.mcpServerStatus().catch(() => [] as any[]),
              gen.supportedCommands().catch(() => [] as any[]),
            ]);
            cache.mcpServers = servers as ClaudeMcpServer[];
            cache.skills = commands as Array<{ name: string; description?: string }>;
            abort.abort();
            break;
          }
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') serverLog('error', 'claude', 'ensureLoadedContext failed', err?.message ?? err);
      } finally {
        clearTimeout(guard);
        loadedContextWarm = null;
      }
    })();
    return loadedContextWarm;
  }

  /** Settle every in-flight / queued turn so their query() promises resolve
   *  when the session ends (input closed, abort, or fatal generator error). */
  function teardownTurns() {
    for (const resolve of pendingPermissions.values()) resolve({ behavior: 'deny', message: 'Session ended' });
    pendingPermissions.clear();
    const stuck = [...pendingPush];
    pendingPush.length = 0;
    activeCycles = 0; // session ending — force the counter to settled
    stoppable = true;
    for (const t of stuck) {
      t.turnSend({ type: 'status', state: 'idle' });
      t.resolve();
    }
    // Active frame: a foreground turn idles + resolves its query(); a server
    // (auto-resume) frame is just dropped (no query to resolve) — mirrors the
    // pre-unify behavior where activeServer was nulled without an idle.
    if (activeFrame && activeFrame.kind === 'foreground') {
      activeFrame.send({ type: 'status', state: 'idle' });
      activeFrame.resolve?.();
    }
    activeFrame = null;
  }

  /**
   * Force every in-flight turn to end NOW — resolve its `query()` and emit idle —
   * WITHOUT touching the persistent session. This is the highest-priority ESC
   * guarantee: the UI (and the sendChain) escape immediately and unconditionally,
   * independent of whether `interrupt()` succeeds. `interrupt()` can be a no-op
   * if the SDK turn already ended but our routing is wedged, so we must not rely
   * on it to unstick the user. Router state is reset so the SDK's now-orphaned
   * trailing messages for the cancelled turn route to `ignore` instead of
   * re-closing or mis-attributing. sendChain serialization means at most one
   * foreground turn is ever in flight (active or a single pending push).
   */
  function cancelActiveTurns() {
    const stuck = [...pendingPush];
    pendingPush.length = 0;
    for (const t of stuck) {
      t.turnSend({ type: 'status', state: 'idle' });
      t.resolve();
    }
    // Active frame — BOTH kinds emit idle (spinner clears); only a foreground
    // frame has a query() promise to resolve.
    if (activeFrame) {
      activeFrame.send({ type: 'status', state: 'idle' });
      activeFrame.resolve?.();
      activeFrame = null;
    }
    activeCycles = 0; // ESC force-settle — unconditional idle above already sent
    router.active = null;
    router.pendingPush = 0;
  }

  function handleSdkMessage(msg: SDKMessage) {
    const any = msg as any;
    if (typeof any.session_id === 'string' && any.session_id) lastSessionId = any.session_id;

    // On the REAL session's init, refresh the /mcp /skills listings from its
    // control methods (full options: app skills + in-process MCP). Fire-and-
    // forget — factory-scoped so it can reach the cache (the per-turn init
    // emitter below is module-level and can't). See refreshLoadedContext.
    if (msg.type === 'system' && (msg as any).subtype === 'init') void refreshLoadedContext();

    // Record each Bash tool_use's run_in_background flag (the tool_use precedes
    // its task_started in the stream) so routeTask can drop FOREGROUND Bash —
    // the SDK emits task_started for slow sync Bash too, which must NOT show as a
    // background-task card. See isForegroundBashTaskStart.
    if (msg.type === 'assistant') {
      for (const block of (((msg as any).message?.content ?? []) as any[])) {
        if (block?.type === 'tool_use' && block.name === 'Bash' && typeof block.id === 'string') {
          bashToolUseBg.set(block.id, block.input?.run_in_background === true);
        }
      }
    }

    const action = routeMessage(router, {
      type: msg.type,
      systemSubtype: msg.type === 'system' ? any.subtype : undefined,
    });

    switch (action.lane) {
      case 'task': routeTask(msg); return;
      case 'ignore':
        // A content-bearing message arrived with NO active turn. In steady state
        // this never fires — if it does, a turn boundary (init/result) was
        // mis-attributed (router drift), or the SDK emitted assistant/tool content
        // after the turn's `result` (active already null). This WAS the silent
        // drop path ("tool use result not showing"). Now: emit the CONTENT
        // session-scoped via lastTurnSend (Phase 2 routes content by type, not
        // turnId, so a stale turnId is fine), with status suppressed (no turn to
        // attribute busy/idle to) and its own blockMsgIds. The drift is still
        // logged (warn) so it stays observable. See turnId-scoping (Phase 3).
        if (msg.type === 'assistant' || msg.type === 'stream_event' || msg.type === 'user') {
          serverLog('warn', 'claude', 'content with no active turn — emitting session-scoped (router drift)', {
            type: msg.type,
            subtype: any.subtype,
            pendingPush: router.pendingPush,
            active: router.active,
          });
          if (lastTurnSend) {
            processMessage(msg, NOOP_SEND, sessionCwd, driftBlockMsgIds, lastTurnSend);
          } else {
            // No turn has ever run → no session send captured → nothing to emit
            // into. Genuinely lost, but there is no conversation to show it in.
            serverLog('error', 'claude', 'content dropped — no session send yet (no turn has run)', { type: msg.type });
          }
        }
        return;
      case 'server':
        if (action.start) openServerFrame();
        routeContent(msg, !!action.close);
        return;
      case 'foreground':
        if (action.start) openForegroundFrame();
        routeContent(msg, !!action.close);
        return;
    }
  }

  function openForegroundFrame() {
    noteCycleOpen();
    const turn = pendingPush.shift();
    if (turn) {
      // lastTurnSend is the RAW (non-idle-deduped) send: server turns + capability
      // + task_event emits base off it and must NOT be swallowed by this turn's
      // idle dedup. The foreground idle itself goes via `send` (= turnSend).
      lastTurnSend = turn.send;
      activeFrame = {
        kind: 'foreground', send: turn.turnSend, blockMsgIds: turn.blockMsgIds,
        forwardAll: true, rawSend: turn.send, cwd: turn.cwd,
        pendingCompactMsgId: turn.pendingCompactMsgId, resolve: turn.resolve,
      };
    } else {
      // Stray init with no pending push — synthesize so content isn't dropped.
      const s = lastTurnSend ?? (() => {});
      activeFrame = {
        kind: 'foreground', send: s, blockMsgIds: createBlockMsgIdState(),
        forwardAll: true, rawSend: s, cwd: sessionCwd, pendingCompactMsgId: null, resolve: () => {},
      };
    }
  }

  /** Open a server-initiated (auto-resume) turn: mint a turnId the main side
   *  registers via `turn_started`, so the prose renders as a normal reply. */
  function openServerFrame() {
    const base = lastTurnSend;
    if (!base) { activeFrame = null; return; }
    noteCycleOpen();
    const turnId = `t-${randomUUID().slice(0, 8)}`;
    base({ type: 'turn_started', turnId });
    // Drive busy state for the auto-resume: streaming on open, idle on close.
    // main forwards these ONLY when no foreground turn is in flight, so the
    // spinner reflects the agent actively writing. See background-tasks#6.
    base({ type: 'status', state: 'streaming', turnId });
    let started = false;
    const send: SendFn = (m) => {
      const tagged: any = { ...m, turnId };
      if (!started && m.type === 'message') { tagged.startsTurn = true; started = true; }
      base(tagged);
    };
    activeFrame = { kind: 'server', send, blockMsgIds: createBlockMsgIdState(), forwardAll: false };
  }

  /**
   * The SINGLE content path for BOTH foreground and auto-resume turns. What a
   * frame forwards is DATA (`forwardAll`), not a separate function — so a new
   * content handler is added in ONE place and can never again be forgotten on
   * one lane (that omission was the dropped-tool_result bug). See
   * features/claude-content-turn-unify.
   */
  function routeContent(msg: SDKMessage, close: boolean) {
    const frame = activeFrame;
    if (!frame) return;
    const any = msg as any;
    const cwd = frame.cwd ?? sessionCwd;

    // ── foreground-only pre-hooks ──
    if (frame.kind === 'foreground') {
      // Mid-turn auth failure → AuthPane takeover (mirrors copilot).
      if (isClaudeAuthFailure(msg)) frame.rawSend!({ type: 'auth_required', provider: 'claude' });
      // /compact completion. The SDK marks a finished compaction with a
      // `compact_boundary` system message (see isCompactBoundary). Failure has
      // no distinct signal — the boundary just never arrives and closeFrame
      // surfaces "Compaction did not complete".
      if (frame.pendingCompactMsgId && isCompactBoundary(msg)) {
        frame.rawSend!({ type: 'message', msgId: frame.pendingCompactMsgId, msgType: 'fold_markdown', label: '/compact', body: { content: 'Compact completed' } });
        frame.pendingCompactMsgId = null;
        stoppable = true;
      }
    }

    // ── content ──
    // FG forwards EVERY message (live stream deltas + the result's cost/usage).
    // Server forwards only assistant/user (prose + tool_results — the latter
    // ride on `user` messages; dropping them was the "整排 tool 卡沒 result" bug)
    // AND the block-boundary stream events: message_start resets the per-index→
    // msgId map, content_block_start advances the index — without them a multi-
    // round auto-resume collapses every reply onto one cached msgId. Server does
    // NOT forward content_block_delta (keeps whole-reply, non-streaming delivery)
    // nor the result (no per-turn cost echo). See features/claude-content-turn-unify.
    if (frame.forwardAll) {
      processMessage(msg, frame.send, cwd, frame.blockMsgIds);
    } else if (msg.type === 'assistant' || msg.type === 'user') {
      processMessage(msg, frame.send, cwd, frame.blockMsgIds);
    } else if (msg.type === 'stream_event') {
      const ev = any.event;
      if (ev?.type === 'message_start' || ev?.type === 'content_block_start') {
        processMessage(msg, frame.send, cwd, frame.blockMsgIds);
      }
    }

    // ── foreground-only post-hook ──
    // Alias resolution → pin concrete model (see agent-config-flow#4).
    if (frame.kind === 'foreground' && msg.type === 'assistant' && any.parent_tool_use_id == null) {
      const resolved = any.message?.model;
      if (shouldAdoptResolvedModel(resolved, currentModel, cache.models ?? [])) {
        currentModel = resolved;
        frame.rawSend!({ type: 'capabilities', ...buildCapabilities() });
      }
    }

    if (close) closeFrame();
  }

  function closeFrame() {
    const frame = activeFrame;
    if (!frame) return;
    activeFrame = null;
    if (frame.kind === 'foreground') {
      // Snapshot the still-running background tasks for reconciliation at the
      // turn boundary. Each was emitted live in routeTask; this is a belt-and-
      // braces authoritative running-set, idempotently upserted. See #75.
      const running = [...backgroundTasks.values()].filter((t) => !t.done);
      if (running.length > 0 && lastTurnSend) lastTurnSend({ type: 'task_event', kind: 'snapshot', tasks: running });
      // Persist the latest SDK session id once per turn.
      if (lastSessionId) frame.rawSend!({ type: 'context_patch', patch: { lastSdkSessionId: lastSessionId } });
      // Compact turn ended without a terminal compact_result — surface a note so
      // the pending card doesn't sit forever (error / abort path).
      if (frame.pendingCompactMsgId) {
        frame.rawSend!({ type: 'message', msgId: frame.pendingCompactMsgId, msgType: 'fold_markdown', label: '/compact', errorMessage: 'Compaction did not complete' });
        frame.pendingCompactMsgId = null;
      }
      stoppable = true;
    }
    // Gate the spinner-clearing idle on the active-cycle counter: if another
    // cycle is still running, this close decrements but does NOT emit idle. For a
    // foreground turn the `result` (forwarded above) already sent the final
    // cost/usage on a streaming-state status the renderer applies regardless.
    emitIdleIfSettled(frame.send);
    frame.resolve?.();
  }

  function routeTask(msg: SDKMessage) {
    const any = msg as any;
    if (!(typeof any.subtype === 'string' && any.subtype.startsWith('task_'))) return;
    const id = any.task_id as string | undefined;
    if (typeof id !== 'string' || !id) {
      serverLog('error', 'claude', 'task_ message with no task_id — dropping (a card may go missing)', { subtype: any.subtype });
      return;
    }
    if (ambientTaskIds.has(id)) return; // known ambient/housekeeping task — intentionally hidden
    if (foregroundBashTaskIds.has(id)) return; // foreground Bash — never a background card
    if (subagentTaskIds.has(id)) return; // subagent — lives in the message list, never a panel card
    // Subagent (Task/Agent tool) classifies at task_started via task_type; drop it
    // and every later event for that id. Its activity surfaces nested under the
    // Agent card in the transcript, not in the background panel. See subagent-display.
    if (isSubagentTaskStart(any)) {
      subagentTaskIds.add(id);
      serverLog('debug', 'claude', 'dropped subagent task_started ' + JSON.stringify({ task_id: id, task_type: any.task_type }));
      return;
    }
    // Foreground (sync) Bash also emits task_started (slow ones do) but isn't a
    // background task. Classify at task_started via the spawning tool_use's
    // run_in_background flag, then drop this + every later event for that id.
    if (isForegroundBashTaskStart(any, bashToolUseBg)) {
      foregroundBashTaskIds.add(id);
      // DIAGNOSTIC: correctly-filtered foreground Bash. Pairs with the "carding"
      // log below — if a foreground card ever leaks, it will appear there (with
      // bgState 'unknown') instead of here, telling us the tool_use linkage broke.
      serverLog('debug', 'claude', 'dropped foreground bash task_started ' + JSON.stringify({ task_id: id, tool_use_id: any.tool_use_id }));
      return;
    }
    // DIAGNOSTIC (fail-loud): we're about to turn THIS task_started into a card.
    // A genuine background Bash always carries a real output_file at notification
    // (spike-confirmed, scripts/spike-sync-vs-bg.ts) — so any card that later
    // reads back empty must be either a FOREGROUND local_bash that leaked past the
    // filter (its tool_use wasn't recorded → bg state 'unknown') or a non-bash
    // task (subagent etc.) whose output is inline, not a file. Log the signal that
    // tells these apart so a stray empty card is diagnosable instead of mysterious.
    if (any.subtype === 'task_started') {
      const tuid = typeof any.tool_use_id === 'string' ? any.tool_use_id : undefined;
      const bgState = any.task_type === 'local_bash'
        ? (tuid && bashToolUseBg.has(tuid) ? String(bashToolUseBg.get(tuid)) : 'unknown')
        : 'n/a';
      serverLog('debug', 'claude', 'carding task_started ' + JSON.stringify({ task_id: id, task_type: any.task_type, tool_use_id: tuid, bgState }));
    }
    const norm = normalizeTaskMessage(msg, backgroundTasks.get(id));
    if (norm?.ambient) { ambientTaskIds.add(id); return; }
    if (!norm) {
      // Unknown task_ subtype (or unparseable) — dropped silently before. Log so
      // a new SDK task subtype that we don't handle is visible instead of a
      // mysteriously-missing card. See #75.
      serverLog('error', 'claude', 'unhandled task_ subtype — dropping', { subtype: any.subtype, task_id: id });
      return;
    }
    backgroundTasks.set(norm.task.id, norm.task);
    if (norm.outputFile) {
      taskOutputFiles.set(norm.task.id, norm.outputFile);
      // Authoritative tasks-dir: the SDK just handed us a real output_file path,
      // so its dirname IS the exact per-session tasks dir — overrides any derived
      // guess and lets sibling tasks (whose own notification was dropped) resolve.
      tasksDir = dirname(norm.outputFile);
      // DIAGNOSTIC (positive counterpart to "settled with no output file"): a
      // real output_file arrived (always via task_notification). Pairs with the
      // no-output log so a reader can see WHETHER/WHEN the file landed for a
      // given task_id — a 'shell' task that only ever logs the no-output line
      // (never this one) is the empty-card bug; one that logs this is healthy.
      serverLog('debug', 'claude', 'recorded output file ' + JSON.stringify({ task_id: norm.task.id, task_type: norm.task.type }));
    }
    // DIAGNOSTIC (fail-loud): the SDK closes out a background task with TWO
    // terminal-ish messages — a `task_updated` (status→completed, NO output_file)
    // then, moments later, a `task_notification` carrying the real output_file.
    // So a `task_updated`-done with no file yet is NORMAL (file still en route)
    // and must NOT be flagged — flagging it false-alarms on every healthy bg task.
    // Only a terminal `task_notification` that STILL has no recorded file is
    // anomalous: the output truly never materialized (live-confirmed ordering via
    // scripts/spike-task-loggers.mjs). Pairs with the "recorded output file" log.
    if (any.subtype === 'task_notification' && !taskOutputFiles.has(norm.task.id)) {
      serverLog('warn', 'claude', 'task_notification settled with no output file ' + JSON.stringify({ task_id: norm.task.id, task_type: norm.task.type, status: norm.task.status }));
    }
    // Emit LIVE — even mid-foreground-turn. task_event is turnId-less and lands
    // in the sticky BackgroundTasksPanel, a separate lane from the turn's content
    // stream, so emitting it now does NOT interleave with the reply — the panel
    // updates as each task starts and settles, instead of all cards popping out
    // at the turn's close. Safe because a SYNC Bash does NOT emit task_started
    // (spike-confirmed, scripts/spike-sync-vs-bg.ts) — only genuinely backgrounded
    // tasks do — so live emission never shows a spurious card for a foreground
    // shell call. This also surfaces a task that settles before the foreground
    // result (the running-only close snapshot would omit it). See #75.
    if (lastTurnSend) lastTurnSend({ type: 'task_event', kind: norm.kind, task: norm.task });
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
      currentModel = model;
      // Apply to the live session via the streaming-mode control method.
      if (session) session.query.setModel(model).catch((e: any) => serverLog('error', 'claude', 'setModel failed', e?.message ?? e));
      lastTurnSend?.({ type: 'capabilities', ...buildCapabilities() });
    },

    setEffort(effort: string) {
      const changed = currentEffort !== effort;
      currentEffort = effort;
      // No control method for effort — rebuild the persistent session (resume
      // keeps context). Rare (user toggles effort mid-conversation). The next
      // query()'s ensureSession recreates with the new options.effort.
      if (changed && session) {
        const old = session;
        session = null;
        try { old.closeInput(); } catch { /* best-effort */ }
        try { old.query.close(); } catch { /* best-effort */ }
      }
      lastTurnSend?.({ type: 'capabilities', ...buildCapabilities() });
    },

    setPermissionMode(mode: string) {
      currentPermissionMode = mode;
      currentBypassMode = mode === 'bypassPermissions';
      if (session) {
        const applied = (currentBypassMode ? 'default' : mode) as Options['permissionMode'];
        session.query.setPermissionMode(applied!).catch((e: any) => serverLog('error', 'claude', 'setPermissionMode failed', e?.message ?? e));
      }
      lastTurnSend?.({ type: 'capabilities', ...buildCapabilities() });
    },

    async query(input: QueryInput, send: SendFn) {
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

      // /mcp /skills: provider-intercepted read-only listings. NOT SDK-
      // dispatchable (interactive-TUI-only) — render normalized, init-cached data
      // as a plain `reply` (full-width markdown table), NOT a fold card — the fold
      // indentation cramps the table. The cache is filled by the real session's
      // refreshLoadedContext once it exists; in the cold-start window (slash before
      // any message) ensureLoadedContext warms it on demand. Still `undefined` after
      // that = the probe genuinely failed → say so (fail-loud), never claim "none".
      if (slash && (slash.cmd === 'mcp' || slash.cmd === 'skills')) {
        send({ type: 'status', state: 'streaming' });
        await ensureLoadedContext(input.cwd, input.appId);
        let content: string;
        if (slash.cmd === 'mcp') {
          content = cache.mcpServers === undefined
            ? 'Could not load the MCP server list — the session failed to initialize.'
            : formatClaudeMcpCard(cache.mcpServers);
        } else {
          content = cache.skills === undefined
            ? 'Could not load the skills list — the session failed to initialize.'
            : formatClaudeSkillsCard(cache.skills, CLAUDE_NON_SKILL_COMMANDS);
        }
        send({ type: 'message', msgId: mintSlashMsgId(), msgType: 'reply', content });
        send({ type: 'status', state: 'idle' });
        return;
      }

      // Seed in-memory session ID from orchestrator-provided context (first
      // turn only; once captured from a live session_id we don't clobber it).
      if (!lastSessionId && input.restoreContext?.lastSdkSessionId) {
        lastSessionId = input.restoreContext.lastSdkSessionId;
      }
      // Renderer sends permissionMode every turn; orchestrator's applyPrefDiff
      // already applied changes via setPermissionMode, but keep bypass in sync
      // defensively (it gates canUseTool's short-circuit).
      if (input.permissionMode) currentBypassMode = input.permissionMode === 'bypassPermissions';

      // Ensure the single persistent streaming-input session exists (created
      // lazily on the first real turn; reused thereafter — Architecture B).
      const s = ensureSession(input.cwd, input.resume, input.appId);

      // Per-turn render state. turnSend de-dupes idle (the result case and the
      // turn-close path can both emit one).
      const blockMsgIds = createBlockMsgIdState();
      let idleEmitted = false;
      const turnSend: SendFn = (msg) => {
        if (msg.type === 'status' && (msg as any).state === 'idle') {
          if (idleEmitted) return;
          idleEmitted = true;
        }
        send(msg);
      };

      // /clear and /compact run a real turn (pushed below) but need
      // provider-side bookkeeping the SDK can't reach.
      if (slash?.cmd === 'clear') {
        send({ type: 'plan', content: '' });
        inflightToolUses.clear();
        tasks.clear();
        pendingTaskCreates.clear();
        pendingTaskLists.clear();
        backgroundTasks.clear();
        taskOutputFiles.clear();
        ambientTaskIds.clear();
        bashToolUseBg.clear();
        foregroundBashTaskIds.clear();
        subagentTaskIds.clear();
        lastSessionId = null;
        send({ type: 'context_patch', patch: { lastSdkSessionId: null } });
      }
      let pendingCompactMsgId: string | null = null;
      if (slash?.cmd === 'compact') {
        pendingCompactMsgId = mintSlashMsgId();
        send({ type: 'message', msgId: pendingCompactMsgId, msgType: 'fold_markdown', label: '/compact' });
        // Whole compact turn is critical — stop() silently no-ops until done.
        stoppable = false;
      }

      // Register the foreground turn, then push its prompt into the live
      // session. The consumer loop attributes the SDK's reply back to this
      // entry (FIFO) and resolves `done` at the foreground result.
      const turn: ForegroundTurn = { send, turnSend, blockMsgIds, cwd: input.cwd, pendingCompactMsgId, resolve: () => {} };
      const done = new Promise<void>((r) => { turn.resolve = r; });
      pendingPush.push(turn);
      notePush(router);

      const imageBlocks = (input.images ?? [])
        .map(dataUrlToImageBlock)
        .filter((b): b is NonNullable<typeof b> => b !== null);
      const content = imageBlocks.length > 0
        ? [...imageBlocks, ...(input.prompt ? [{ type: 'text' as const, text: input.prompt }] : [])]
        : input.prompt;
      s.pushUser(content as SDKUserMessage['message']['content']);
      await done;
    },

    async stop() {
      // Silently ignore mid-compaction (or any other critical section the
      // provider sets `stoppable = false` for). Interrupting `/compact`
      // half-way leaves the session in an indeterminate state.
      if (!stoppable) return;
      for (const resolve of pendingPermissions.values()) {
        resolve({ behavior: 'deny', message: 'Stopped by user' });
      }
      pendingPermissions.clear();
      // HIGHEST PRIORITY: unstick the UI + sendChain immediately and
      // unconditionally, BEFORE (and independent of) interrupt(). interrupt()
      // can be a slow await or a no-op (SDK turn already ended), so we never let
      // ESC depend on it to escape. This emits idle + resolves the turn's
      // query() synchronously.
      cancelActiveTurns();
      if (session) {
        try {
          // Best-effort: actually stop the SDK turn (saves tokens). Its trailing
          // result is now ignored (the turn is already closed above). Keeps the
          // session alive for the next prompt.
          await session.query.interrupt();
        } catch (err: any) {
          // Interrupt fail-loud, then fall back to AbortController. Repeated
          // occurrence means the SDK interrupt surface broke.
          serverLog('error', 'claude', 'interrupt() failed; aborting session', err?.message ?? err);
          try { session.abort.abort(); } catch { /* best-effort */ }
        }
      }
    },

    dispose() {
      if (session) {
        try { session.closeInput(); } catch { /* best-effort */ }
        try { session.query.close(); } catch { /* best-effort */ }
        try { session.abort.abort(); } catch { /* best-effort */ }
        session = null;
      }
      backgroundTasks.clear();
      taskOutputFiles.clear();
      ambientTaskIds.clear();
      bashToolUseBg.clear();
      foregroundBashTaskIds.clear();
      subagentTaskIds.clear();
    },

    resetSession(_sessionId: string) {
      // Drop our resume pointer; SDK has no per-session in-memory state we own.
      // Next query() with no `restoreContext.lastSdkSessionId` will start fresh.
      lastSessionId = null;
    },

    /**
     * Re-scan plugins (our app skills are injected as a local plugin) on the
     * LIVE session so an app-level skill edit is live without re-init. Uses the
     * SDK's documented `query.reloadPlugins()` ("reload plugins from disk").
     * Best-effort: no live session → nothing to reload; failure logs and leaves
     * the current state (change still lands on next session init). We refresh the
     * `/skills` `/mcp` cache from the reload result so the cards reflect the new
     * set immediately. NOTE: reload makes a NEW skill model-invocable but does
     * not rebuild Claude's `/` slash parser index — a brand-new skill may still
     * be missing from `/` autocomplete until a full restart (editing an existing
     * skill is unaffected). See GOTCHAS.
     */
    async reloadSkills() {
      const q = session?.query;
      if (!q) {
        serverLog('warn', 'claude', 'reloadSkills: no live session — app-skill edit will apply on next session init');
        return { reloaded: false, ok: true };
      }
      try {
        const refreshed = await q.reloadPlugins();
        cache.skills = refreshed.commands as Array<{ name: string; description?: string }>;
        cache.mcpServers = refreshed.mcpServers as ClaudeMcpServer[];
        // Log success so a dev build can confirm the reload re-scanned plugins
        // from disk for the live session. plugins/commands counts let us eyeball
        // that our app-skill local plugin is present. See skills#4.
        serverLog('warn', 'claude', 'reloadPlugins() applied — app-skill edit now live (effective next turn) '
          + JSON.stringify({ plugins: refreshed.plugins?.length ?? 0, commands: cache.skills.length }));
        return { reloaded: true, ok: true };
      } catch (err: any) {
        serverLog('warn', 'claude', 'reloadPlugins() failed; app-skill edit will apply on next session init instead', err?.message ?? err);
        return { reloaded: true, ok: false, error: err?.message ?? String(err) };
      }
    },

    async stopTask(taskId: string) {
      // Streaming-mode control method; the SDK emits a task_notification
      // (status 'stopped') in response, which the consumer routes to a
      // task_event so the card updates. No live session → nothing to stop.
      if (!session) return;
      try {
        await session.query.stopTask(taskId);
      } catch (err: any) {
        serverLog('error', 'claude', 'stopTask failed', { taskId, message: err?.message ?? err });
      }
    },

    /**
     * Enumerate backgrounded SHELL tasks for the reaper (the detached bg bash —
     * the only kind that escapes the tree; subagents/monitors/workflows are
     * inline). Claude exposes no pid, so `pid` is omitted; the reaper kills via
     * `stopTask` (KillShell by shell_id) above. Read-only snapshot.
     */
    async listReapableTasks(): Promise<ReapableTask[]> {
      const out: ReapableTask[] = [];
      for (const t of backgroundTasks.values()) {
        if (t.type !== 'shell') continue;
        out.push({ id: t.id, kind: 'shell', status: t.done ? 'done' : 'running' });
      }
      return out;
    },

    async readTaskOutput(taskId: string): Promise<string> {
      let file = taskOutputFiles.get(taskId);
      // No recorded path means the terminal task_notification (sole carrier of
      // output_file) never arrived for this task — the upstream delivery bug for
      // tasks that settle mid-turn / in batches (issue refs: see
      // pickSessionTasksDir in helpers.ts). The output file itself IS on disk, so
      // reconstruct `<tasksDir>/<id>.output`. tasksDir is the exact dir from any
      // earlier notification, else derived by globbing the session id.
      if (!file) {
        const dir = tasksDir ?? deriveTasksDir(lastSessionId);
        if (dir) {
          const candidate = join(dir, `${taskId}.output`);
          if (existsSync(candidate)) {
            file = candidate;
            tasksDir ??= dir; // cache a derived hit for sibling tasks
            serverLog('debug', 'claude', 'readTaskOutput: recovered via tasks dir ' + JSON.stringify({ task_id: taskId, dir }));
          }
        }
      }
      // Still nothing: a subagent/monitor/workflow whose output is inline, or a
      // genuinely fileless task. Return a calm note rather than throwing.
      if (!file) {
        serverLog('warn', 'claude', 'readTaskOutput: no output file for task ' + JSON.stringify({ task_id: taskId, task_type: backgroundTasks.get(taskId)?.type ?? 'unknown', known: backgroundTasks.has(taskId), triedDir: tasksDir ?? deriveTasksDir(lastSessionId) ?? null }));
        return '(no output recorded for this task)';
      }
      // We run ON the remote, so this reads the remote file directly — main /
      // renderer never touch the remote fs. Cap the read so a runaway log can't
      // blow up the wire / renderer; note truncation explicitly.
      const MAX = 256 * 1024;
      const buf = await readFile(file);
      if (buf.length > MAX) {
        return buf.subarray(buf.length - MAX).toString('utf8')
          + `\n\n… (truncated — showing last ${MAX / 1024}KB of ${Math.round(buf.length / 1024)}KB)`;
      }
      return buf.toString('utf8');
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
type InflightToolUseEntry = (
  | { kind: 'tool_use'; toolName: string; input: string }
  | { kind: 'file_edit'; filePath: string; diff?: { oldString: string; newString: string }; content?: string }
) & {
  // Set when this tool_use was emitted BY A SUBAGENT (SDK parent_tool_use_id).
  // Re-applied at tool_result time so the completed card keeps its nesting link.
  parentId?: string;
};
const inflightToolUses = new Map<string, InflightToolUseEntry>();

// Fail-loud policy (context/agent-observability): an incoming event must never
// vanish without a trace. This dedups "unknown wire type" warns so SDK drift is
// observable without flooding the log when a new type recurs every chunk/message.
const seenUnknownWire = new Set<string>();
function warnUnknownWireOnce(kind: string, detail: string): void {
  const key = `${kind}:${detail}`;
  if (seenUnknownWire.has(key)) return;
  seenUnknownWire.add(key);
  serverLog('warn', 'claude', `unhandled ${kind} — not rendered (SDK drift?)`, { detail });
}

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
 * See agent-ui#1 and GOTCHAS (Claude SDK 0.3.x TaskCreate) for rationale.
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
 * Background tasks — DISTINCT from the `tasks` plan/TODO map above. These mirror
 * the SDK's `task_*` system messages (a backgrounded Bash, subagent, etc.) and
 * are emitted to the renderer via the turnId-less `task_event` lane. Accumulating
 * here lets `task_updated`/`task_notification` merge with the fields established
 * at `task_started`. `taskOutputFiles` stashes the remote `output_file` path
 * (server-only — not a render primitive; consumed by the M2 read_task_output RPC).
 * See background-tasks#2 (Phase 0 confirmed the SDK shapes).
 */
const backgroundTasks = new Map<string, NormalizedTask>();
const taskOutputFiles = new Map<string, string>();
// task_started.skip_transcript === true marks ambient/housekeeping tasks the
// SDK says to hide from the transcript. We drop them from the card stream.
const ambientTaskIds = new Set<string>();
// Bash tool_use id → run_in_background flag (recorded when the assistant emits
// the tool_use, which precedes its task_started). Lets routeTask tell a real
// backgrounded Bash from a FOREGROUND one — the SDK emits task_started for slow
// sync Bash too, but those aren't background tasks. See isForegroundBashTaskStart.
const bashToolUseBg = new Map<string, boolean>();
// task_ids classified as foreground Bash → all their subsequent task_ events
// (updated / notification) are dropped too, so no card ever appears for them.
const foregroundBashTaskIds = new Set<string>();
// task_ids classified as subagent (Task/Agent tool, task_type subagent/local_agent)
// → dropped from the background panel: a subagent has a single home in the message
// list (its outer Agent card, with inner steps nested under it), not the panel,
// which is reserved for fire-and-forget Bash run_in_background. See subagent-display.
const subagentTaskIds = new Set<string>();



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
  parentToolUseId?: string,
): void {
  // When set (subagent inner tool_use), nest under the outer Agent card and keep
  // the link on the inflight entry so the tool_result re-emit stays nested too.
  const parent = parentToolUseId ? { parentToolUseId } : {};
  if (block.name === 'Edit') {
    const input = block.input as { file_path?: string; old_string?: string; new_string?: string };
    if (typeof input.file_path === 'string'
      && typeof input.old_string === 'string'
      && typeof input.new_string === 'string') {
      const diff = { oldString: input.old_string, newString: input.new_string };
      inflightToolUses.set(block.id, { kind: 'file_edit', filePath: input.file_path, diff, parentId: parentToolUseId });
      send({
        type: 'message', msgId: block.id, msgType: 'fold_diff',
        label: 'Edit',
        subtitle: stripCwd(input.file_path, cwd),
        ...parent,
      });
      return;
    }
    // Malformed Edit — fall through to generic fold_code so we don't drop it.
  }
  if (block.name === 'Write') {
    const input = block.input as { file_path?: string; content?: string };
    if (typeof input.file_path === 'string' && typeof input.content === 'string') {
      inflightToolUses.set(block.id, {
        kind: 'file_edit', filePath: input.file_path, content: input.content, parentId: parentToolUseId,
      });
      send({
        type: 'message', msgId: block.id, msgType: 'fold_code',
        label: 'Write',
        subtitle: stripCwd(input.file_path, cwd),
        ...parent,
      });
      return;
    }
    // Fall through.
  }
  const input = formatClaudeToolInput(block.name, block.input, cwd);
  inflightToolUses.set(block.id, {
    kind: 'tool_use', toolName: block.name, input, parentId: parentToolUseId,
  });
  send({
    type: 'message', msgId: block.id, msgType: 'fold_code',
    label: block.name,
    subtitle: input,
    ...parent,
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
  if (!entry) {
    // The tool_use that registered this id is gone from the process-local
    // inflight map — its entry was set in a PRIOR agent-server process/state
    // (e.g. the session got re-hosted onto a new process, whose map starts
    // empty). Do NOT silently drop the result: that leaves the card blank
    // forever AND erases the only evidence of the anomaly (which is why it was
    // undiagnosable). Fail loud — log the id so the triggering lifecycle event
    // is visible next time — and surface it to the renderer as an error card,
    // keeping the raw output as the body so no data is lost.
    serverLog('warn', 'claude', 'orphan tool_result: no inflight entry (map lost the tool_use — likely a session re-host)', {
      toolUseId, isError, contentPreview: content.slice(0, 200),
    });
    send({
      type: 'message', msgId: toolUseId, msgType: 'fold_code',
      label: 'Tool result',
      body: { content: isError ? stripToolErrorWrapper(content) : content },
      errorMessage: 'Tool result arrived with no matching call (orphaned — see agent-server log).',
    });
    return;
  }
  inflightToolUses.delete(toolUseId);
  // Preserve subagent nesting across the pending→completed upsert (same msgId):
  // the result re-emit must carry the same parentToolUseId or the renderer drops
  // the child back to the top level.
  const parent = entry.parentId ? { parentToolUseId: entry.parentId } : {};
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
        ...parent,
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
        ...parent,
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
      ...parent,
    });
  }
}

// Accumulate rate-limit buckets across events so we can always send the full
// set to the UI.  Key = bucket label (e.g. '5h', '7d').
const rateLimitBuckets = new Map<string, StatusSegment>();

export function processMessage(msg: SDKMessage, send: SendFn, cwd: string, blockMsgIds: BlockMsgIdState, contentSend?: SendFn) {
  // DISPLAY content (reply / fold_* / stream / tool result) goes via `content`;
  // STATUS (streaming/idle) + plan stay on `send`. `contentSend` lets the caller
  // route content session-scoped (independent of the active turn) so it's never
  // dropped at the turn-router seam; defaults to `send` (turn-scoped) → identical
  // behavior when omitted. See turnId-scoping (Phase 3).
  const content = contentSend ?? send;
  switch (msg.type) {
    case 'assistant': {
      // Map content[] positions to absolute block indices by anchoring the
      // LAST entry to `lastBlockStartIdx`. See BlockMsgIdState docstring for
      // why this works across delta / growing-partial / cumulative shapes.
      const N = msg.message.content.length;
      const baseIdx = blockMsgIds.lastBlockStartIdx - N + 1;
      // Set on messages EMITTED BY A SUBAGENT — the renderer nests them under the
      // outer Agent/Task card (whose msgId === this id) instead of the main list.
      const parentId = msg.parent_tool_use_id ?? undefined;
      const parent = parentId ? { parentToolUseId: parentId } : {};
      msg.message.content.forEach((block, i) => {
        const idx = baseIdx + i;
        if (block.type === 'thinking') {
          // Reuse msgId if stream chunks already minted one for this block;
          // otherwise (no streaming or non-streamed model) mint fresh.
          content({
            type: 'message', msgId: getOrMintBlockMsgId(blockMsgIds, idx), msgType: 'fold_text',
            label: 'Thinking',
            body: { content: block.thinking, tone: 'muted' },
            ...parent,
          });
        } else if (block.type === 'text') {
          content({
            type: 'message', msgId: getOrMintBlockMsgId(blockMsgIds, idx), msgType: 'reply',
            content: block.text,
            ...parent,
          });
        } else if (block.type === 'tool_use') {
          emitClaudeToolUse(content, { id: block.id, name: block.name, input: block.input as Record<string, unknown> }, cwd, parentId);
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
        // alias-resolution block in query() and agent-config-flow#4.
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
          content({ type: 'stream', msgId, streamType: 'text', content: delta.text });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
          content({ type: 'stream', msgId, streamType: 'thinking', content: delta.thinking });
        } else if (delta.type !== 'text_delta' && delta.type !== 'thinking_delta') {
          // Unknown delta type (SDK drift) — empty text/thinking deltas are
          // benign noise, but a NEW delta type carrying content must not vanish.
          warnUnknownWireOnce('stream delta type', String((delta as any).type));
        }
      }
      break;
    }
    case 'user': {
      if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if ((block as any).type === 'tool_result') {
            const raw = (block as any).content;
            const contentText = extractToolResultText(raw);
            const toolUseId = (block as any).tool_use_id;
            const isError = (block as any).is_error === true;

            // TaskCreate completion: promote pending → tasks Map using
            // server-assigned id from the result payload.
            if (!isError && pendingTaskCreates.has(toolUseId)) {
              const pending = pendingTaskCreates.get(toolUseId)!;
              pendingTaskCreates.delete(toolUseId);
              const taskId = parseTaskCreateOutput(contentText);
              if (taskId) {
                tasks.set(taskId, { ...pending, status: 'pending' });
                renderPlan(send, tasks);
              } else {
                // Parser failed on a tool_result we KNOW is TaskCreate — SDK
                // wire format likely changed. Drops the task from the plan
                // panel; next TaskList reconcile can recover. Log the format
                // so we know what to fix.
                serverLog('error', 'claude', 'TaskCreate result parse failed; format may have changed', { contentPreview: contentText.slice(0, 300) });
              }
            }

            // TaskList output: reconcile local Map against server ground truth.
            // Only attempt for tool_use_ids we registered as TaskList.
            if (!isError && pendingTaskLists.has(toolUseId)) {
              pendingTaskLists.delete(toolUseId);
              const snapshot = parseTaskListOutput(contentText);
              if (snapshot) {
                reconcileTasks(tasks, snapshot, send);
              } else {
                serverLog('error', 'claude', 'TaskList result parse failed; format may have changed', { contentPreview: contentText.slice(0, 300) });
              }
            }

            emitClaudeToolResult(content, toolUseId, contentText, isError, cwd);
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
      // Emit this turn's final cost/usage but DON'T flip the spinner to idle here.
      // The busy/idle transition is owned by the active-cycle counter: the router's
      // close (emitIdleIfSettled) sends idle only when ALL cycles have drained, so
      // an overlapping auto-resume can't clear the spinner mid-flight. `state:
      // 'streaming'` keeps the spinner up; the renderer's setStatus applies the
      // cost/usage fields regardless of state (agentTabStore.setStatus). See
      // features/claude-content-turn-unify.
      send({
        type: 'status', state: 'streaming',
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
    default: {
      // Fail-loud on an unrecognized SDK message type instead of silently
      // dropping it — SDK drift (a new type carrying real content) must leave a
      // trace. See fail-loud policy (context/agent-observability).
      warnUnknownWireOnce('SDK message type', String((msg as any).type));
      break;
    }
  }
}
