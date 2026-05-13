import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'node:crypto';
import type { QueryInput, SendFn, ServerBackend, ProviderCapabilities, StatusSegment, PickerResolvePayload } from './types';
import { severityFromUtilization, formatResetCountdown, pickPermissionModes, pickEffortLevels } from './types';
import { parseSlashPrefix } from '../../src/shared/slash-prefix';
import type { ProviderModel } from '../../src/shared/types';

const COPILOT_QUOTA_LABELS: Record<string, string> = {
  premium_interactions: 'premium',
  chat_interactions: 'chat',
};

/**
 * Convert a Copilot `AssistantUsageQuotaSnapshot` to a `StatusSegment`.
 *
 * Field semantics (verified against `node_modules/@github/copilot/app.js`):
 * - `usedRequests` is *derived* from `entitlement * (1 - percent_remaining)`
 *   so it saturates at `entitlementRequests` and CANNOT itself surface
 *   overage. Using only this field gives a hard 100% ceiling.
 * - `overage` is a separate counter for requests beyond the entitlement
 *   (the upstream API returns it as `overage_count` on `chat`/`premium_interactions`/etc.).
 *
 * → utilization = (usedRequests + overage) / entitlementRequests, so 25
 * overage on a 10-request quota correctly renders 350%.
 *
 * Returns `null` for unlimited entitlements (no meaningful quota %) or when
 * we can't form a denominator.
 */
export function quotaSnapshotToSegment(
  key: string,
  snap: any,
): StatusSegment | null {
  if (!snap || snap.isUnlimitedEntitlement) return null;

  let u: number;
  if (typeof snap.entitlementRequests === 'number'
    && snap.entitlementRequests > 0
    && typeof snap.usedRequests === 'number') {
    const overage = typeof snap.overage === 'number' ? Math.max(0, snap.overage) : 0;
    u = Math.max(0, (snap.usedRequests + overage) / snap.entitlementRequests);
  } else if (typeof snap.remainingPercentage === 'number') {
    // Fallback when request counts are missing — caps at 100% (SDK quirk).
    u = Math.max(0, 1 - snap.remainingPercentage);
  } else {
    return null;
  }

  const label = COPILOT_QUOTA_LABELS[key] ?? key;
  const pct = Math.round(u * 100);
  const reset = snap.resetDate ? formatResetCountdown(Date.parse(snap.resetDate)) : null;
  const severity = snap.usageAllowedWithExhaustedQuota === false && u >= 1
    ? 'critical'
    : severityFromUtilization(u);
  return {
    text: `${label}: ${pct}%${reset ? ` ↻${reset}` : ''}`,
    severity,
  };
}

const execFileP = promisify(execFile);

/**
 * In-flight tool calls awaiting their `tool.execution_complete` event.
 * Mirrors the Claude provider's pattern: keyed by toolCallId, stores enough
 * to re-emit the same canonical message with `result` populated when complete.
 */
type InflightToolUseEntry =
  | { kind: 'tool_use'; toolName: string; input: string }
  | { kind: 'file_edit'; filePath: string; diff?: { oldString: string; newString: string }; content?: string }
  /**
   * `apply_patch` parsed into N file_edit sub-cards. SDK gives a single
   * patch-level success/failure on tool.execution_complete; we re-emit each
   * sub-card with that same result, and additionally emit a top-level error
   * message on failure so the timeline shows the patch-level reason loudly.
   */
  | { kind: 'apply_patch'; subs: Array<{ msgId: string; spec: ApplyPatchFileSpec }> };
const inflightToolUses = new Map<string, InflightToolUseEntry>();

function stripCwd(p: string, cwd: string): string {
  if (!cwd || !p) return p;
  if (p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return p;
}

/**
 * Format a Copilot CLI tool's `arguments` object into a single human-readable
 * string for the renderer. Mirrors `formatClaudeToolInput` but for Copilot's
 * lowercase / snake_case tool names (bash, view, grep, glob, list_directory…).
 *
 * `apply_patch` is parsed separately via `parseApplyPatch`, so we never reach
 * this formatter for it. `task_complete` / `report_intent` are intercepted
 * earlier (rendered as text/intent), also never here.
 *
 * Falls back to first string value / JSON for unknown tools so MCP custom
 * tools still surface something useful.
 */
export function formatCopilotToolInput(toolName: string, args: Record<string, unknown>, cwd: string): string {
  switch (toolName) {
    case 'bash':
    case 'shell':
      return String(args.command ?? '');
    case 'view':
    case 'read_file':
    case 'read': {
      const p = String(args.path ?? args.file_path ?? '');
      return stripCwd(p, cwd);
    }
    case 'list_directory': {
      const p = String(args.path ?? '');
      return stripCwd(p, cwd) || '.';
    }
    case 'grep': {
      const pattern = String(args.pattern ?? args.query ?? '');
      const p = args.path ? ` in ${stripCwd(String(args.path), cwd)}` : '';
      return pattern + p;
    }
    case 'glob': {
      const pattern = String(args.pattern ?? '');
      const p = args.path ? ` in ${stripCwd(String(args.path), cwd)}` : '';
      return pattern + p;
    }
    case 'task': {
      const at = args.agent_type ? `${args.agent_type}: ` : '';
      const name = args.name ? `${args.name} — ` : '';
      const prompt = String(args.prompt ?? args.description ?? '');
      return `${at}${name}${prompt.slice(0, 100)}`;
    }
    default: {
      const firstStr = Object.values(args).find((v) => typeof v === 'string') as string | undefined;
      if (firstStr) return firstStr;
      return JSON.stringify(args);
    }
  }
}

export type ApplyPatchFileSpec =
  | { kind: 'update'; filePath: string; diff: { oldString: string; newString: string } }
  | { kind: 'add'; filePath: string; content: string };

/**
 * Parse Copilot's `apply_patch` raw-string args into one or more normalized
 * file_edit payloads. Each `*** Update File:` / `*** Add File:` section
 * becomes its own entry; multi-hunk in the same Update file produces multiple
 * entries with the same filePath (one per `@@` hunk — Claude's typical "edit
 * different regions of the same file" pattern maps cleanly).
 *
 * Returns null when the patch contains a `*** Delete File:` (no canonical
 * representation yet) or when the structure is malformed. Caller should fall
 * back to a generic `tool_use` card in that case so nothing is silently lost.
 */
export function parseApplyPatch(patch: string): ApplyPatchFileSpec[] | null {
  if (typeof patch !== 'string') return null;
  // Strip outer Begin/End Patch markers.
  const begin = patch.indexOf('*** Begin Patch');
  const end = patch.indexOf('*** End Patch');
  if (begin < 0 || end < 0 || end < begin) return null;
  const inner = patch.slice(begin + '*** Begin Patch'.length, end).replace(/^\s*\n/, '').replace(/\n\s*$/, '');

  // Delete is the only operation we explicitly don't support yet.
  if (/\*\*\*\s+Delete\s+File:/.test(inner)) return null;

  // Split into file sections. Each section starts with `*** Update|Add File: ...`
  // and continues until the next `*** ` marker or end-of-inner. We use a
  // capture-everything regex with non-greedy lookahead.
  const sectionRe = /\*\*\*\s+(Update|Add)\s+File:\s*([^\n]+)\n([\s\S]*?)(?=\n\*\*\*\s+(?:Update|Add|Delete)\s+File:|$)/g;
  const specs: ApplyPatchFileSpec[] = [];
  let match: RegExpExecArray | null;
  while ((match = sectionRe.exec(inner)) !== null) {
    const op = match[1];
    const filePath = match[2].trim();
    const body = match[3].replace(/\n\s*$/, '');
    if (op === 'Add') {
      const lines: string[] = [];
      for (const line of body.split('\n')) {
        if (line.startsWith('+')) lines.push(line.slice(1));
      }
      specs.push({ kind: 'add', filePath, content: lines.join('\n') });
      continue;
    }
    // op === 'Update' — body starts with `@@` (possibly with optional context),
    // and may contain multiple `@@` hunks. Split on `@@` boundaries.
    const hunks = body.split(/^@@.*$/m).map((h) => h.replace(/^\n+/, '').replace(/\n+$/, '')).filter((h) => h.length > 0);
    if (hunks.length === 0) return null;
    for (const hunk of hunks) {
      const oldLines: string[] = [];
      const newLines: string[] = [];
      for (const line of hunk.split('\n')) {
        if (line.startsWith('+')) newLines.push(line.slice(1));
        else if (line.startsWith('-')) oldLines.push(line.slice(1));
        else if (line.startsWith(' ')) {
          const c = line.slice(1);
          oldLines.push(c);
          newLines.push(c);
        }
        // Empty / non-prefixed lines (e.g. trailing whitespace): ignored.
      }
      specs.push({
        kind: 'update',
        filePath,
        diff: { oldString: oldLines.join('\n'), newString: newLines.join('\n') },
      });
    }
  }

  return specs.length > 0 ? specs : null;
}

async function readGhToken(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP('gh', ['auth', 'token'], { timeout: 3000 });
    const tok = stdout.trim();
    return tok || undefined;
  } catch {
    return undefined;
  }
}

type PermissionResult =
  | { behavior: 'allow'; scope?: 'once' | 'session' }
  | { behavior: 'deny'; message?: string };

// Map Copilot's PermissionRequest.kind to the approve-for-session approval sub-shape
// it expects back. shell/mcp/custom-tool/url/hook need data we don't have here
// (commandIdentifiers / serverName / toolName), so omit approval and let the SDK
// fall back to its default session-allow behavior for those kinds.
function approvalForKind(kind: string): any | undefined {
  switch (kind) {
    case 'read': return { kind: 'read' };
    case 'write': return { kind: 'write' };
    case 'memory': return { kind: 'memory' };
    default: return undefined;
  }
}

const DEFAULT_MODEL = 'gpt-5.5';

// /model intentionally not listed — it's a renderer-local config-edit slash
// (see src/renderer/components/AgentView.tsx RENDERER_LOCAL_SLASHES). The
// renderer merges its own command list into the autocomplete display.
const SLASH_COMMANDS = [
  { name: 'context', description: 'Show context window usage' },
  { name: 'compact', description: 'Summarize conversation to free up context' },
  { name: 'clear', description: 'Reset the conversation context' },
  { name: 'help', description: 'List available slash commands' },
];

let sdkModule: typeof import('@github/copilot-sdk') | null = null;
async function getSdk() {
  if (!sdkModule) sdkModule = await import('@github/copilot-sdk');
  return sdkModule;
}

/**
 * Resolve the Copilot CLI's entry point. The Copilot SDK spawns this as a
 * subprocess (the CLI does the actual API/auth/state work; SDK is just a
 * JSON-RPC wrapper).
 *
 * **Why packaged path is `extraResources/copilot-cli/`, not
 * `app.asar.unpacked/node_modules/@github/copilot/`:**
 * Copilot CLI's bundled `app.js` does a naive `path.replace("app.asar",
 * "app.asar.unpacked")` when resolving its native `spawn-helper` binary,
 * assuming Electron apps always live under `app.asar/`. If the path already
 * contains `app.asar.unpacked` (as it does when we asarUnpack the package),
 * the replace duplicates the suffix to `app.asar.unpacked.unpacked` and the
 * helper is no longer found → `posix_spawnp failed` on every bash tool call.
 *
 * Putting Copilot under `extraResources` sidesteps the bug entirely — the
 * Resources/copilot-cli/ path contains no `app.asar` substring, so the
 * upstream replace is a no-op. This also aligns better with what Copilot CLI
 * actually is: a bundled subprocess (like ffmpeg shipped with an app), not a
 * `require()`-able library — extraResources is the right pattern for that.
 */
function resolveCopilotCliPath(): string | undefined {
  // The @github/copilot package's index.js is the entry point that resolves
  // the platform-specific native modules internally. SDK runs `node index.js`.
  const candidates = [
    // Dev: relative to agent-server bundle output (dist/agent-server/<v>/index.mjs)
    path.resolve(__dirname, '..', '..', '..', 'node_modules', '@github', 'copilot', 'index.js'),
    // Dev: relative to project root (when running unbundled via tsx/ts-node)
    path.resolve(__dirname, '..', '..', 'node_modules', '@github', 'copilot', 'index.js'),
    // Packaged: extraResources/copilot-cli/ (sits next to extraResources/agent-server/
    // — both are siblings of agent-server bundle dir).
    path.resolve(__dirname, '..', '..', 'copilot-cli', 'index.js'),
    // User global install (~/.nvm or system) — last-resort fallback if our
    // bundle is missing somehow.
    path.join(os.homedir(), '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', '@github', 'copilot', 'index.js'),
    '/usr/local/lib/node_modules/@github/copilot/index.js',
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

interface CachedModel {
  id: string;
  name?: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

interface CopilotState {
  client: import('@github/copilot-sdk').CopilotClient | null;
  session: import('@github/copilot-sdk').CopilotSession | null;
  /** Copilot CLI's session ID (separate from our app's sessionId). */
  cliSessionId: string | null;
  /** Cached models from last listModels() call. */
  models: CachedModel[];
}

// Mint a unique msgId for a non-tool message (text/thinking/intent/system/
// error/plan). Tool messages use the SDK-provided toolCallId as their msgId
// — see file_edit / tool_use emit sites below.
function mintMsgId(): string {
  return `m-${randomUUID().slice(0, 8)}`;
}

export function createCopilotBackend(): ServerBackend {
  const pendingPermissions = new Map<string, (result: PermissionResult) => void>();
  let currentSend: SendFn | null = null;
  let currentModel = DEFAULT_MODEL;
  let currentEffort: string | undefined;
  let currentPermissionMode = 'default';
  let currentSessionId: string | null = null;
  // Per-turn streaming msgId trackers. Copilot SDK doesn't emit explicit
  // block-start events; we mint on the first delta of a channel and reuse
  // until the matching finalize message lands. Reset to null when finalize
  // arrives or a new turn begins.
  let currentTextMsgId: string | null = null;
  let currentThinkingMsgId: string | null = null;
  // workingDirectory must be threaded into createSession/resumeSession config —
  // omitting it leaves the CLI's bash tool spawning relative to agent-server's
  // own cwd (which on packaged Electron is something like /), causing
  // "posix_spawnp failed" when the shell tries to run from a non-existent or
  // unreadable working directory.
  let currentCwd: string | null = null;
  // External vocabulary (shared with Claude) → Copilot SDK SessionMode.
  const MODE_TO_SDK: Record<string, 'interactive' | 'plan' | 'autopilot'> = {
    default: 'interactive',
    bypassPermissions: 'autopilot',
    plan: 'plan',
  };
  let latestUsage: {
    currentTokens: number;
    tokenLimit: number;
    conversationTokens?: number;
    systemTokens?: number;
    toolDefinitionsTokens?: number;
    messagesLength: number;
  } | null = null;
  const state: CopilotState = { client: null, session: null, cliSessionId: null, models: [] };

  // Stoppable flag — provider-internal stop semantics. Set to false during
  // critical sections (e.g. compact in flight, /clear's dispose+rebuild
  // window) so stop() silently no-ops. Not surfaced to renderer — Cursor /
  // Claude Code / Aider all behave the same way (button always present, some
  // operations just can't be interrupted). If we ever want explicit
  // "cannot stop" UI feedback, add a `stoppable` field on status events.
  let stoppable = true;

  /**
   * Marks a code block as non-cancellable. Sets `stoppable = false` for the
   * duration so concurrent stop() calls are silently ignored, restored in
   * the finally regardless of throw. Use sparingly — only for sections where
   * an interrupt would leave session state half-modified (compaction in
   * flight, session disconnect+rebuild, etc.).
   */
  async function critical<T>(fn: () => Promise<T>): Promise<T> {
    stoppable = false;
    try { return await fn(); } finally { stoppable = true; }
  }

  // Pending picker promises keyed by picker id (minted when the provider
  // emits a picker_request). resolvePicker drains the matching entry with
  // the renderer's PickerResolvePayload (answers or cancelled). Filled in
  // when Step 4 of picker-request redesign wires the elicitation handler.
  const pendingPickers = new Map<string, (payload: PickerResolvePayload) => void>();

  function modelMeta(id: string): CachedModel | undefined {
    return state.models.find((m) => m.id === id);
  }

  function effortsFor(modelId: string): string[] {
    return modelMeta(modelId)?.supportedReasoningEfforts ?? [];
  }

  function buildCapabilities(): ProviderCapabilities & { currentModel: string; currentEffort?: string; currentPermissionMode: string } {
    return {
      currentModel,
      currentEffort,
      currentPermissionMode,
      models: state.models.map((m) => ({
        value: m.id,
        displayName: m.name ?? m.id,
        effortLevels: pickEffortLevels(m.supportedReasoningEfforts ?? []),
      })),
      // acceptEdits has no Copilot equivalent — omit it (honest capability surface).
      permissionModes: pickPermissionModes(['default', 'bypassPermissions', 'plan']),
      effortLevels: pickEffortLevels(effortsFor(currentModel)),
      slashCommands: SLASH_COMMANDS,
      authMethod: {
        kind: 'oauth' as const,
        instructions: [
          { label: 'Sign in via gh CLI', command: 'gh auth login -s copilot' },
        ],
      },
    };
  }

  // Permission handler: bridge Copilot SDK permission requests to our existing
  // permission_request IPC contract (UI shows Allow/Deny buttons).
  // PermissionRequest shape: { kind: "shell"|"write"|"mcp"|"read"|"url"|"custom-tool"|"memory"|"hook", toolCallId? }
  const onPermissionRequest = async (request: any) => {
    // bypassPermissions short-circuit: don't trust rpc.mode.set to have
    // landed (session may have been created before mode was switched, and
    // SDK silently swallows mode-set failures). Always auto-approve here.
    if (currentPermissionMode === 'bypassPermissions') {
      return { kind: 'approve-once' as const };
    }
    const toolUseId = request.toolCallId ?? `copilot-${Date.now()}`;
    // PermissionRequest's typed shape is just { kind, toolCallId }, but the
    // runtime payload carries kind-specific fields (intention, path, command,
    // commands[], possiblePaths, etc.). Pass everything except kind/toolCallId
    // through as `input` so the UI can show what's actually being requested.
    const { kind: _kind, toolCallId: _tcId, ...rest } = request ?? {};
    currentSend?.({
      type: 'permission_request',
      toolUseId,
      toolName: request?.kind ?? 'unknown',
      input: rest,
    });
    const result = await new Promise<PermissionResult>((resolve) => {
      pendingPermissions.set(toolUseId, resolve);
    });
    if (result.behavior === 'deny') {
      return { kind: 'reject' as const, feedback: result.message };
    }
    if (result.scope === 'session') {
      const approval = approvalForKind(request.kind);
      return approval
        ? { kind: 'approve-for-session' as const, approval }
        : { kind: 'approve-for-session' as const };
    }
    return { kind: 'approve-once' as const };
  };

  async function ensureClient(): Promise<import('@github/copilot-sdk').CopilotClient> {
    if (state.client) return state.client;
    const { CopilotClient } = await getSdk();
    const cliPath = resolveCopilotCliPath();
    if (!cliPath) {
      throw new Error('GitHub Copilot CLI not found. Install with: npm install -g @github/copilot');
    }
    // Force gh-CLI auth path: explicit gitHubToken takes priority over keychain/plaintext,
    // so the spawned CLI never touches macOS Keychain (no scary OS prompt).
    // Mirrors how the Claude integration relies on the user's existing Claude Code login.
    const ghToken = await readGhToken();
    if (!ghToken) {
      throw new Error('GitHub Copilot 需要 gh CLI 登入。請執行：gh auth login -s copilot');
    }
    state.client = new CopilotClient({
      cliPath,
      useStdio: true,
      gitHubToken: ghToken,
      useLoggedInUser: false,
      logLevel: 'warning',
      // Suppress Node's "SQLite is experimental" warning the CLI emits on stdout/stderr.
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    await state.client.start();
    return state.client;
  }

  async function ensureSession(): Promise<import('@github/copilot-sdk').CopilotSession> {
    if (state.session) return state.session;
    const client = await ensureClient();
    const config: any = {
      model: currentModel,
      onPermissionRequest,
    };
    if (currentEffort) config.reasoningEffort = currentEffort;
    if (currentCwd) config.workingDirectory = currentCwd;

    let session: import('@github/copilot-sdk').CopilotSession;
    if (state.cliSessionId) {
      try {
        session = await client.resumeSession(state.cliSessionId, config);
      } catch {
        session = await client.createSession(config);
      }
    } else {
      session = await client.createSession(config);
    }
    state.session = session;
    state.cliSessionId = session.sessionId;
    // Tell orchestrator to persist this so the next process can resume the
    // same Copilot CLI session (CLI keeps session state on disk by sessionId).
    currentSend?.({ type: 'context_patch', patch: { lastSdkSessionId: session.sessionId } });

    // If user already picked a non-default mode before this session existed, apply it.
    // Note: bypassPermissions has its own short-circuit in onPermissionRequest,
    // so even if this rpc.mode.set silently fails, bypass still works.
    const sdkMode = MODE_TO_SDK[currentPermissionMode];
    if (sdkMode && sdkMode !== 'interactive') {
      try { await (session as any).rpc.mode.set({ mode: sdkMode }); } catch { /* ignore */ }
    }

    // Wire events to send fn. Copilot CLI's built-in tools (read_file, edit, bash, etc.)
    // are used directly; we don't register custom tools.
    session.on((event: any) => {
      if (!currentSend) return;
      switch (event.type) {
        case 'assistant.message_delta':
          if (event.data?.deltaContent) {
            // Mint msgId on first delta of this text block; reuse until finalize.
            if (currentTextMsgId === null) currentTextMsgId = mintMsgId();
            currentSend({ type: 'stream', msgId: currentTextMsgId, streamType: 'text', content: event.data.deltaContent });
          }
          break;
        case 'assistant.reasoning_delta':
          if (event.data?.deltaContent) {
            if (currentThinkingMsgId === null) currentThinkingMsgId = mintMsgId();
            currentSend({ type: 'stream', msgId: currentThinkingMsgId, streamType: 'thinking', content: event.data.deltaContent });
          }
          break;
        case 'assistant.message':
          if (event.data?.content) {
            // Use the streaming msgId if there was one; otherwise mint
            // (covers the case where SDK skips deltas and sends final only).
            const msgId = currentTextMsgId ?? mintMsgId();
            currentSend({ type: 'message', msgId, msgType: 'text', content: event.data.content });
            currentTextMsgId = null;  // Reset for the next text block in this turn.
          }
          break;
        case 'assistant.reasoning':
          if (event.data?.content) {
            const msgId = currentThinkingMsgId ?? mintMsgId();
            currentSend({ type: 'message', msgId, msgType: 'thinking', content: event.data.content });
            currentThinkingMsgId = null;
          }
          break;
        case 'tool.execution_start': {
          const toolName = event.data?.toolName ?? 'unknown';
          const args = event.data?.arguments ?? {};
          const toolUseId = event.data?.toolCallId ?? '';

          // `task_complete` is end-of-turn signal — args.summary carries the
          // assistant's final reply. Render as text, skip matching result.
          if (toolName === 'task_complete') {
            const text = args.summary ?? args.text ?? args.message ?? args.content ?? '';
            if (text) currentSend({ type: 'message', msgId: mintMsgId(), msgType: 'text', content: text });
            break;
          }

          // `report_intent` announces "I'm about to do X" — render as intent line,
          // skip matching result. args.intent is a string.
          if (toolName === 'report_intent') {
            if (typeof args.intent === 'string' && args.intent.length > 0) {
              currentSend({ type: 'message', msgId: mintMsgId(), msgType: 'intent', content: args.intent });
            }
            break;
          }

          // `apply_patch` carries a raw unified-diff string (NOT object args).
          // Try to normalize into one or more canonical file_edit cards (one
          // per file, plus one per hunk in multi-hunk updates). Fall through
          // to generic tool_use only when parser returns null (Delete /
          // malformed / no parseable sections).
          if (toolName === 'apply_patch' && typeof args === 'string') {
            const parsed = parseApplyPatch(args);
            if (parsed) {
              // Each sub-card gets a distinct msgId so renderer's upsert
              // doesn't collapse them. Prefix with toolUseId so the
              // relationship is recoverable in logs.
              const subs = parsed.map((spec, i) => ({
                msgId: `${toolUseId}:f${i}`,
                spec,
              }));
              inflightToolUses.set(toolUseId, { kind: 'apply_patch', subs });
              for (const { msgId, spec } of subs) {
                currentSend({
                  type: 'message', msgId, msgType: 'file_edit',
                  // Each sub-card mirrors the patch's toolUseId — they share a
                  // single permission/execution lifecycle on the SDK side.
                  toolUseId,
                  filePath: spec.filePath,
                  ...(spec.kind === 'update' ? { diff: spec.diff } : { content: spec.content }),
                });
              }
              break;
            }
          }

          // Generic tool_use path. For apply_patch fallback (multi-hunk /
          // multi-file / Delete that parseApplyPatch refused), wrap the raw
          // string into a one-shot `{ patch }` object so the formatter has
          // something to chew on — output will be the raw patch text, ugly
          // but not lost.
          const argObj: Record<string, unknown> = typeof args === 'string'
            ? { patch: args }
            : args;
          const input = formatCopilotToolInput(toolName, argObj, currentCwd ?? '');
          inflightToolUses.set(toolUseId, { kind: 'tool_use', toolName, input });
          currentSend({
            type: 'message', msgId: toolUseId, msgType: 'tool_use',
            toolUseId,
            toolName,
            input,
          });
          break;
        }
        case 'tool.execution_complete': {
          const data = event.data ?? {};
          const toolUseId = data.toolCallId ?? '';
          // task_complete / report_intent had their tool_use suppressed (rendered
          // as text/intent), so no inflight entry — skip silently.
          const entry = inflightToolUses.get(toolUseId);
          if (!entry) break;
          inflightToolUses.delete(toolUseId);

          const isError = data.success === false;
          if (entry.kind === 'file_edit') {
            currentSend({
              type: 'message', msgId: toolUseId, msgType: 'file_edit',
              toolUseId,
              filePath: entry.filePath,
              ...(entry.diff ? { diff: entry.diff } : {}),
              ...(entry.content !== undefined ? { content: entry.content } : {}),
              result: isError
                ? { success: false, error: data.error?.message ?? 'edit failed' }
                : { success: true },
            });
          } else if (entry.kind === 'apply_patch') {
            // Patch-level success/failure applies to every sub-card. SDK
            // doesn't tell us which file caused failure (and apply_patch is
            // typically all-or-nothing — validation fails before any write),
            // so we mark every sub-card with the same result.
            //
            // Per-card error text intentionally stays generic ("apply_patch
            // failed") — repeating the detailed SDK reason on N cards is
            // visual noise, and ✗ + a single top-level error message
            // already tell the full story. The detail lives on the
            // top-level error message below.
            const detailMsg = data.error?.message ?? 'unknown error';
            for (const { msgId, spec } of entry.subs) {
              currentSend({
                type: 'message', msgId, msgType: 'file_edit',
                toolUseId,
                filePath: spec.filePath,
                ...(spec.kind === 'update' ? { diff: spec.diff } : { content: spec.content }),
                result: isError
                  ? { success: false, error: 'apply_patch failed' }
                  : { success: true },
              });
            }
            // On failure, surface a top-level error message carrying the
            // patch-level reason. Each sub-card's ✗ tells "this file
            // wasn't changed"; the timeline error tells WHY.
            if (isError) {
              currentSend({
                type: 'message', msgId: mintMsgId(), msgType: 'error',
                content: `Patch operation failed: ${detailMsg}`,
              });
            }
          } else {
            // Use `content` (concise, what the LLM sees) over `detailedContent`
            // (SDK-side rich UI returning reads as fake unified diffs).
            const text = isError
              ? `Error: ${data.error?.message ?? 'tool failed'}`
              : (data.result?.content ?? '');
            currentSend({
              type: 'message', msgId: toolUseId, msgType: 'tool_use',
              toolUseId,
              toolName: entry.toolName,
              input: entry.input,
              result: { content: String(text).slice(0, 8000), ...(isError ? { isError: true } : {}) },
            });
          }
          break;
        }
        case 'assistant.usage': {
          const quotaSnapshots = event.data?.quotaSnapshots as Record<string, any> | undefined;
          const rateLimits: StatusSegment[] = [];
          if (quotaSnapshots) {
            for (const [key, snap] of Object.entries(quotaSnapshots)) {
              const seg = quotaSnapshotToSegment(key, snap);
              if (seg) rateLimits.push(seg);
            }
          }
          currentSend({
            type: 'status', state: 'streaming',
            model: currentModel,
            inputTokens: event.data?.inputTokens,
            outputTokens: event.data?.outputTokens,
            ...(rateLimits.length > 0 ? { rateLimits } : {}),
          });
          break;
        }
        case 'session.usage_info': {
          const cur = event.data?.currentTokens ?? 0;
          const limit = event.data?.tokenLimit ?? 0;
          latestUsage = {
            currentTokens: cur,
            tokenLimit: limit,
            conversationTokens: event.data?.conversationTokens,
            systemTokens: event.data?.systemTokens,
            toolDefinitionsTokens: event.data?.toolDefinitionsTokens,
            messagesLength: event.data?.messagesLength ?? 0,
          };
          if (limit > 0) {
            const ratio = cur / limit;
            currentSend({
              type: 'status', state: 'streaming',
              contextUsage: {
                text: `ctx: ${Math.round(ratio * 100)}%`,
                severity: severityFromUtilization(ratio),
              },
            });
          }
          break;
        }
        case 'session.plan_changed':
          // Debounced fetch — multiple rapid changes coalesce into one read.
          schedulePlanRead();
          break;
        case 'session.error': {
          // ErrorData fields: message, errorType, errorCode, httpStatus,
          // providerCallId, stack. Compose a human-readable string from
          // whatever's present so the UI never shows "Unknown error".
          const data = event.data ?? {};
          const parts: string[] = [];
          if (data.errorType) parts.push(`[${data.errorType}]`);
          parts.push(data.message ?? 'Session error');
          if (data.httpStatus) parts.push(`(HTTP ${data.httpStatus})`);
          if (data.errorCode) parts.push(`code=${data.errorCode}`);
          currentSend({ type: 'error', error: parts.join(' ') });
          break;
        }
        case 'model.call_failure': {
          // ModelCallFailureData uses `errorMessage` (NOT `message`); previous
          // code looked for `message`/`error` and always fell through to
          // "Unknown error". Surface statusCode + model to make these useful
          // for debugging.
          const data = event.data ?? {};
          const parts: string[] = ['Model call failed'];
          if (data.errorMessage) parts.push(`— ${data.errorMessage}`);
          if (data.statusCode) parts.push(`(HTTP ${data.statusCode})`);
          if (data.model) parts.push(`[${data.model}]`);
          currentSend({ type: 'error', error: parts.join(' ') });
          break;
        }
      }
    });
    return session;
  }

  let planReadTimer: NodeJS.Timeout | null = null;
  function schedulePlanRead() {
    if (planReadTimer) return;
    planReadTimer = setTimeout(async () => {
      planReadTimer = null;
      if (!state.session || !currentSend) return;
      try {
        const result = await (state.session as any).rpc.plan.read();
        currentSend({
          type: 'message',
          msgId: mintMsgId(),
          msgType: 'plan',
          content: result?.exists ? (result.content ?? '') : '',
        });
      } catch { /* ignore */ }
    }, 150);
  }

  async function listModelsCached(): Promise<CachedModel[]> {
    const client = await ensureClient();
    const list = await client.listModels();
    state.models = list.map((m: any) => ({
      id: m.id ?? m.name ?? String(m),
      name: m.name ?? m.id,
      supportedReasoningEfforts: m.supportedReasoningEfforts,
      defaultReasoningEffort: m.defaultReasoningEffort,
    }));
    return state.models;
  }

  /**
   * Internal slash dispatcher. Sole entry point is `query()` — when the
   * prompt parses as `/cmd args`, query() routes here before any SDK call.
   *
   * Slash output is emitted as `slash_response` messages (pending → terminal
   * status, same msgId for upsert). For slashes that touch session state
   * (compact, clear), the critical-section is wrapped in `critical()` so
   * concurrent stop() calls don't leave the session half-modified.
   *
   * `/model` is intentionally NOT handled here — it's a renderer-local
   * config-edit slash (see src/renderer/components/AgentView.tsx
   * RENDERER_LOCAL_SLASHES). Renderer intercepts before send IPC fires;
   * if a /model slash somehow reaches this dispatcher, it falls into the
   * default "unknown command" branch — that's intentional, signals the
   * routing layer above failed.
   */
  async function dispatchSlash(cmd: string, args: string, send: SendFn): Promise<void> {
    const emitSlash = (msgId: string, status: 'pending' | 'success' | 'error', content: string) => {
      send({ type: 'message', msgId, msgType: 'slash_response', slashCmd: cmd, status, content });
    };

    switch (cmd) {
      case 'help': {
        const msgId = mintMsgId();
        const lines = SLASH_COMMANDS.map((c) => `- /${c.name} — ${c.description}`).join('\n');
        emitSlash(msgId, 'success', `Available commands:\n${lines}`);
        return;
      }

      case 'context': {
        const msgId = mintMsgId();
        emitSlash(msgId, 'pending', 'Reading context...');
        if (!latestUsage) {
          emitSlash(msgId, 'error', 'No context info yet. Send a message first.');
          return;
        }
        const u = latestUsage;
        const pct = u.tokenLimit > 0 ? Math.round((u.currentTokens / u.tokenLimit) * 100) : 0;
        const fmt = (n?: number) => n != null ? n.toLocaleString() : '-';
        const lines = [
          `Context: ${fmt(u.currentTokens)} / ${fmt(u.tokenLimit)} tokens (${pct}%)`,
          `Messages: ${u.messagesLength}`,
          `  - Conversation: ${fmt(u.conversationTokens)}`,
          `  - System: ${fmt(u.systemTokens)}`,
          `  - Tools: ${fmt(u.toolDefinitionsTokens)}`,
        ];
        emitSlash(msgId, 'success', lines.join('\n'));
        return;
      }

      case 'compact': {
        const msgId = mintMsgId();
        emitSlash(msgId, 'pending', 'Compacting...');
        if (!state.session) {
          emitSlash(msgId, 'error', 'No active session to compact.');
          return;
        }
        try {
          await critical(async () => {
            const result = await (state.session as any).rpc.history.compact();
            if (!result?.success) {
              emitSlash(msgId, 'error', 'Compaction failed');
              return;
            }
            const removed = result.tokensRemoved?.toLocaleString() ?? '?';
            const msgs = result.messagesRemoved ?? 0;
            emitSlash(msgId, 'success', `Compacted: freed ${removed} tokens across ${msgs} messages.`);
          });
        } catch (err: any) {
          emitSlash(msgId, 'error', `Compact failed: ${err?.message ?? err}`);
        }
        return;
      }

      case 'clear': {
        // Eager rebuild semantics: dispose old session, immediately create a
        // fresh one bound to the *current* cwd. Without the new-session step,
        // Copilot CLI's server-side session state (which includes
        // workingDirectory) would be re-restored on the next query via any
        // persisted lastSdkSessionId. ensureSession() emits context_patch
        // with the new sessionId, so persisted state stays consistent.
        //
        // Persistence handling: clear lastSdkSessionId in context_patch up
        // front so even if ensureSession fails, next launch starts cold
        // (won't try to resume the just-disposed SDK session). On success,
        // ensureSession's own context_patch with the new id overwrites.
        // Context-file cleanup is the provider's responsibility — slash
        // flows through send/query() and there's no separate orchestrator
        // hook for /clear semantics.
        //
        // First-/clear-before-any-query is treated as a successful no-op so
        // tests / fresh environments don't trip on missing auth or CLI binary.
        const msgId = mintMsgId();
        emitSlash(msgId, 'pending', 'Clearing context...');
        try {
          await critical(async () => {
            const hadSession = !!state.session || !!state.cliSessionId;
            try { await state.session?.disconnect(); } catch { /* ignore */ }
            state.session = null;
            state.cliSessionId = null;
            latestUsage = null;
            inflightToolUses.clear();
            send({ type: 'context_patch', patch: { lastSdkSessionId: null } });
            send({ type: 'message', msgId: mintMsgId(), msgType: 'plan', content: '' });
            if (hadSession) {
              try {
                await ensureSession();
              } catch (err: any) {
                emitSlash(msgId, 'error', `Cleared, but failed to start new session: ${err?.message ?? err}`);
                return;
              }
            }
            emitSlash(msgId, 'success', 'Context cleared');
          });
        } catch (err: any) {
          emitSlash(msgId, 'error', `Clear failed: ${err?.message ?? err}`);
        }
        return;
      }

      default: {
        const msgId = mintMsgId();
        emitSlash(msgId, 'error', `Unknown command: /${cmd}`);
        return;
      }
    }
  }

  return {
    async gatherCapabilities(_cwd: string, sessionId?: string, _customModels?: ProviderModel[]): Promise<ProviderCapabilities> {
      // Copilot SDK validates model names against GitHub's model API; user-provided
      // custom IDs would be rejected at runtime, so we ignore customModels here.
      if (sessionId) currentSessionId = sessionId;
      await listModelsCached();
      if (!currentEffort) currentEffort = modelMeta(currentModel)?.defaultReasoningEffort;
      return buildCapabilities();
    },

    async query(input: QueryInput, send: SendFn) {
      currentSend = send;
      // Reset per-turn streaming msgId state — prior turn's leftover would
      // otherwise let chunks from this turn attach to a stale msgId.
      currentTextMsgId = null;
      currentThinkingMsgId = null;

      // Slash detection. Bypass normal SDK setup — most slashes are
      // pre-SDK ops (help/context), session-rebuilding ops (clear), or
      // session-aware RPC calls (compact). None benefit from the
      // model/effort/mode sync that precedes a real SDK send. Renderer-local
      // slashes (/model /effort /permission) are intercepted before send IPC
      // fires, so anything reaching here is a provider slash by elimination.
      const slash = parseSlashPrefix(input.prompt);
      if (slash) {
        send({ type: 'status', state: 'streaming', model: currentModel });
        try {
          await dispatchSlash(slash.cmd, slash.args, send);
        } finally {
          // Slash idle deliberately omits cost / tokens / numTurns /
          // contextUsage — renderer keeps last real turn's metric values.
          send({ type: 'status', state: 'idle' });
        }
        return;
      }
      // Hydrate cliSessionId from orchestrator-provided context. Only the
      // first turn after a process restart needs this — once we've created
      // or resumed a session in-memory, we don't clobber.
      if (!state.cliSessionId && input.restoreContext?.lastSdkSessionId) {
        state.cliSessionId = input.restoreContext.lastSdkSessionId;
      }
      // Pref sync (model / effort / permissionMode) is handled by the
      // orchestrator's applyPrefDiff before query() runs — see
      // agent-server/index.ts. By this point closure currentModel /
      // currentEffort / currentPermissionMode already match input, so we
      // don't need to do the diff here anymore.
      if (input.sessionId) currentSessionId = input.sessionId;
      // Capture cwd before ensureSession so workingDirectory lands in createSession config.
      // If cwd changes mid-session (e.g. user switches project), we don't recreate the
      // session — Copilot CLI doesn't have a rpc.cwd.set, and most users stay in one
      // project per session. The first cwd we see wins.
      if (input.cwd && !currentCwd) currentCwd = input.cwd;

      send({ type: 'status', state: 'streaming', model: currentModel });

      try {
        const session = await ensureSession();
        // SDK default timeout is 60s, way too short for agent turns that
        // chain tool calls (file reads, greps, shell). 30 min is a generous
        // upper bound that still catches genuinely-stuck sessions.
        await session.sendAndWait({ prompt: input.prompt }, 30 * 60 * 1000);
        send({ type: 'status', state: 'idle', model: currentModel });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (msg.includes('not authenticated') || msg.includes('auth')) {
          send({ type: 'auth_required', provider: 'copilot' });
        } else {
          send({ type: 'error', error: `Copilot error: ${msg}` });
        }
        send({ type: 'status', state: 'idle' });
      }
    },

    async stop() {
      // Silently ignore while provider is in a non-cancellable critical
      // section (compact in flight, /clear's dispose+rebuild window).
      // Interrupting mid-way would leave session state half-modified.
      if (!stoppable) return;
      for (const resolve of pendingPermissions.values()) {
        resolve({ behavior: 'deny', message: 'Stopped by user' });
      }
      pendingPermissions.clear();
      try { await state.session?.abort(); } catch { /* ignore */ }
    },

    dispose() {
      try { state.session?.disconnect(); } catch { /* ignore */ }
      try { state.client?.stop(); } catch { /* ignore */ }
      state.session = null;
      state.client = null;
    },

    resetSession(_sessionId: string) {
      // Drop in-memory session refs so the next query() starts a fresh CLI
      // session instead of trying to resume from a now-deleted lastSdkSessionId.
      // Disconnect best-effort; the live session is being abandoned anyway.
      try { state.session?.disconnect(); } catch { /* ignore */ }
      state.session = null;
      state.cliSessionId = null;
      latestUsage = null;
      inflightToolUses.clear();
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

    /**
     * Apply model to the current Copilot session. Imperative — orchestrator
     * decides when to call (only on diff). Effort comes along because
     * `session.setModel` takes it as the second-arg config; effort fallback
     * to model's default if currently unsupported.
     */
    async setModel(model: string) {
      const supported = effortsFor(model);
      if (currentEffort && !supported.includes(currentEffort)) {
        currentEffort = modelMeta(model)?.defaultReasoningEffort;
      } else if (!currentEffort) {
        currentEffort = modelMeta(model)?.defaultReasoningEffort;
      }
      currentModel = model;
      if (state.session) {
        await state.session.setModel(model, currentEffort ? { reasoningEffort: currentEffort as any } : undefined);
      }
      // Capabilities re-broadcast for renderer status bar — capability list
      // itself didn't change, but currentModel did.
      currentSend?.({ type: 'capabilities', ...buildCapabilities() });
    },

    async setEffort(effort: string) {
      currentEffort = effort;
      if (state.session) {
        await state.session.setModel(currentModel, { reasoningEffort: effort as any });
      }
    },

    async setPermissionMode(mode: string) {
      currentPermissionMode = mode;
      if (state.session) {
        const sdkMode = MODE_TO_SDK[mode];
        if (sdkMode) {
          await (state.session as any).rpc.mode.set({ mode: sdkMode });
        }
      }
    },
  };
}
