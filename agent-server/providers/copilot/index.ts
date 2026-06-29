import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import type { QueryInput, SendFn, ServerBackend, ProviderCapabilities, StatusSegment, PickerResolvePayload } from '../types';
import { severityFromUtilization, pickPermissionModes, pickEffortLevels } from '../types';
import { parseSlashPrefix } from '@shared/slash-prefix';
import { formatConfigAck, type ConfigEditKey } from '@shared/config-ack';
import type { ProviderModel } from '@shared/types';
import { stripCwd, resolveSkillsPluginRoot } from '../shared';
import { runBridgeTool, APP_SKILL_LIST_DESC, APP_SKILL_GET_DESC, APP_SKILL_CREATE_DESC, APP_SKILL_UPDATE_DESC, WEB_FETCH_DESC, SHELF_BRIDGE_TOOLS } from '../../app-tool-tools';
import { WEB_FETCH_TOOL } from '@shared/web-session';
import { serverLog } from '../../server-logger';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  quotaSnapshotToSegment,
  formatCopilotToolInput,
  parseApplyPatch,
  elicitationSchemaToPrompts,
  picksToElicitationContent,
  normalizeCopilotTask,
  isBackgroundedCopilotTask,
  buildCopilotAuthConfig,
  buildOrphanFinalizeMessages,
  formatCopilotMcpCard,
  formatCopilotSkillsCard,
  type InflightToolUseEntry,
} from './helpers';

const execFileP = promisify(execFile);

/**
 * Transitional: read a GitHub token from the `gh` CLI if it's installed AND
 * authed. Used to keep the old gitHubToken auth path (no macOS Keychain prompt)
 * when gh is present, while still working without gh (caller falls back to
 * useLoggedInUser). gh is OPTIONAL: any failure (not installed → ENOENT, not
 * authed, no scope, empty output) resolves to `undefined` and NEVER throws.
 * On remotes this runs remote-side, picking up the remote's own gh — consistent
 * with where Copilot itself runs. See agent-providers#2.
 */
async function readGhToken(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP('gh', ['auth', 'token'], { timeout: 3000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

// In-flight tool calls awaiting their `tool.execution_complete` event (keyed by
// toolCallId). Mirrors the Claude provider's pattern. Type + the orphan-card
// builder live in helpers.ts. See InflightToolUseEntry there.
const inflightToolUses = new Map<string, InflightToolUseEntry>();
// Copilot SDK `session.on` event types we KNOWINGLY don't render — pure
// lifecycle / already-covered-elsewhere. Enumerated (observed live, 2026-06) so
// the switch default only warns for a genuinely NEW/unknown type instead of
// spamming these benign ones on every turn. Notes on the non-obvious ones:
//   permission.requested/completed → handled via registered onPermissionRequest
//   session.idle / assistant.turn_end → idle is driven by sendAndWait() resolving
//   session.task_complete → final reply handled via tool.execution_start(task_complete)
const KNOWN_IGNORED_COPILOT_EVENTS = new Set<string>([
  'pending_messages.modified', 'system.message',
  'session.tools_updated', 'user.message', 'assistant.turn_start',
  'assistant.turn_end', 'assistant.intent', 'hook.start', 'hook.end',
  'permission.requested', 'permission.completed', 'tool.execution_partial_result',
  'session.task_complete', 'session.idle',
]);
// Genuinely-unexpected types we've warned about once (dedup so a new type that
// SHOULD be handled is visible without spamming).
const seenUnhandledCopilotEvents = new Set<string>();

// TEMP DIAG (copilot big-grep hang): trace the FULL lifecycle of every tool
// call + system notification straight to stderr → main log, regardless of
// whether the switch below renders it. Goal: see, for a large `rg`/grep that
// "hangs with no error", which events actually arrive — does
// tool.execution_complete ever fire, or does the card stay running until the
// 30-min turn timeout? Are partial_result/progress streaming (feedback we drop)?
// Single-line JSON so grep stays sane. partial_result can be high-volume, so we
// aggregate per toolCallId and only log first + every 50th + the final tally.
// Remove once root cause is confirmed.
const diagPartials = new Map<string, { n: number; bytes: number }>();
function diagTraceCopilotToolEvent(event: any): void {
  const t = event?.type;
  const d = event?.data ?? {};
  const id = d.toolCallId ?? d.shellId ?? d.agentId ?? '';
  switch (t) {
    case 'tool.execution_start':
      serverLog('debug', 'copilot', 'DIAG tool.start ' + JSON.stringify({ id, tool: d.toolName, args: JSON.stringify(d.arguments ?? '').slice(0, 200) }));
      break;
    case 'tool.execution_partial_result': {
      const prev = diagPartials.get(id) ?? { n: 0, bytes: 0 };
      const next = { n: prev.n + 1, bytes: prev.bytes + (typeof d.partialOutput === 'string' ? d.partialOutput.length : 0) };
      diagPartials.set(id, next);
      if (next.n === 1 || next.n % 50 === 0) serverLog('debug', 'copilot', 'DIAG tool.partial ' + JSON.stringify({ id, chunks: next.n, bytes: next.bytes }));
      break;
    }
    case 'tool.execution_progress':
      serverLog('debug', 'copilot', 'DIAG tool.progress ' + JSON.stringify({ id, msg: String(d.progressMessage ?? '').slice(0, 200) }));
      break;
    case 'tool.execution_complete': {
      const tally = diagPartials.get(id);
      diagPartials.delete(id);
      serverLog('debug', 'copilot', 'DIAG tool.complete ' + JSON.stringify({ id, success: d.success, hasResult: d.result != null, resultType: d.result?.type, errType: d.error?.type, partials: tally?.n ?? 0 }));
      break;
    }
    case 'system.notification':
      serverLog('debug', 'copilot', 'DIAG system.notification ' + JSON.stringify({ kind: d.kind?.type ?? d.kind, content: String(d.content ?? '').slice(0, 160) }));
      break;
    case 'session.error':
    case 'model.call_failure':
      serverLog('debug', 'copilot', 'DIAG ' + t + ' ' + JSON.stringify({ msg: d.message ?? d.errorMessage, code: d.errorCode ?? d.statusCode }));
      break;
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
  // /mcp /skills: provider-intercepted read-only listings (see dispatchSlash).
  // NOT SDK-dispatchable (interactive-TUI-only) — Shelf prints them from data
  // captured via the skills_loaded / mcp_servers_loaded session events. Listed
  // here so they appear in autocomplete + /help (list ↔ dispatch must be paired).
  { name: 'mcp', description: 'List loaded MCP servers' },
  { name: 'skills', description: 'List loaded skills' },
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
  // R1: on a remote deploy we ship the standalone Copilot binary next to
  // index.mjs (`<__dirname>/copilot`); copilot-sdk spawns it directly (non-.js
  // cliPath → no node, no node-24 requirement). Dev/packaged keep the
  // @github/copilot dispatcher (JS path). We deliberately do NOT fall back to a
  // remote-global install (~/.nvm, /usr/local) — the remote's CLI is never used
  // (R1: ship our own, ignore what's installed).
  const candidates = [
    // Remote self-contained deploy: standalone Copilot binary.
    path.resolve(__dirname, 'copilot'),
    // Dev: relative to agent-server bundle output (dist/agent-server/<v>/index.mjs)
    path.resolve(__dirname, '..', '..', '..', 'node_modules', '@github', 'copilot', 'index.js'),
    // Dev: relative to project root (when running unbundled via tsx/ts-node)
    path.resolve(__dirname, '..', '..', 'node_modules', '@github', 'copilot', 'index.js'),
    // Packaged: extraResources/copilot-cli/ (sibling of agent-server bundle dir).
    path.resolve(__dirname, '..', '..', 'copilot-cli', 'index.js'),
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
  // App-instance id (for the projected skills dir); bound on first query, used
  // when the session is created. Like currentCwd, first value wins.
  let currentAppId: string | undefined;
  // Raw listings (NOT a normalized cross-provider type) for the `/mcp` `/skills`
  // cards; the markdown is composed on read by formatCopilot*Card. Filled by the
  // session's skills_loaded / mcp_servers_loaded events (which fire on a TURN /
  // reconnect — NOT on bare session creation), or pulled via RPC on cold-start
  // (ensureLoadedContext). `undefined` = not yet loaded → slash says so, never
  // claims "none".
  let loadedMcpServers: Array<{ name: string; status?: string; error?: string; source?: string }> | undefined;
  let loadedSkills: Array<{ name: string; description?: string; enabled?: boolean; source?: string }> | undefined;
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
      // Option A: the user signs in ON the remote host via the Copilot CLI's
      // own device-flow login (`copilot login` → shows a code, authorize in any
      // browser). Credential is written to the remote's own ~/.copilot and
      // NEVER crosses machines. We deliberately do NOT bind `gh` (removed in
      // 6d5c615) — the Copilot CLI has its own login.
      authMethod: {
        kind: 'oauth' as const,
        instructions: [
          { label: 'Run this in a terminal on the remote host, then click Retry', command: 'copilot login' },
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
    // Auth (transitional dual-path):
    //  - gh present+authed → pass its token as `gitHubToken` (forces
    //    useLoggedInUser:false). The CLI then uses that token and never reads its
    //    own keychain login → no macOS Keychain prompt (gh stores its token in a
    //    plaintext file). This restores the pre-6d5c615 behaviour, but gh is now
    //    OPTIONAL (only used if present), not a hard dependency.
    //  - no gh → fall back to `useLoggedInUser: true` (Copilot's own login; on
    //    macOS that lives in the keychain and may prompt on unsigned builds).
    // See agent-providers#2. The keychain tradeoff is the reason gh is offered
    // back as an opt-in shortcut while a permanent fix (signing) is decided.
    const ghToken = await readGhToken();
    state.client = new CopilotClient({
      cliPath,
      useStdio: true,
      ...buildCopilotAuthConfig(ghToken),
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
    // Match the native Copilot CLI: auto-discover the project's own skill dirs
    // (`.github/skills`, `.agents/skills`, `.claude/skills` — Copilot reads
    // Claude's dir cross-tool; verified against copilot CLI 1.0.56's own
    // "Skills are loaded from: Project:" help text) + MCP configs (`.mcp.json`,
    // `.vscode/mcp.json`) from the working directory. Project-level config is the
    // official tools' domain — Shelf just turns native discovery on so the agent
    // view matches the raw CLI, and does NOT bridge/rewrite it. See PRODUCT.md #5.
    // Discovered dirs merge with the explicit app-skill `skillDirectories` below
    // (explicit wins on name collision).
    config.enableConfigDiscovery = true;
    // App-level skills (Shelf's domain, NOT native): point Copilot at this app's
    // projected skills collection (the inner `skills/` dir, parent of the skill
    // folders) when it exists. See #2.5/#70. Session-cached — new skills
    // mid-session may need `/skills reload`.
    const skillsRoot = resolveSkillsPluginRoot(currentAppId);
    if (skillsRoot) config.skillDirectories = [path.join(skillsRoot, 'skills')];

    // In-process app-level bridge tools. As of copilot-sdk 1.0.56 tools are
    // passed in the session CONFIG (`config.tools`, the typed/documented API) —
    // NOT via a post-create `session.registerTools()` (removed from the public
    // API). That's why config-based skillDirectories load but the bridge didn't:
    // registering after createSession no longer surfaces the tools to the model.
    // skipPermission on the read ops (safe); mutations omit it → user confirms.
    config.tools = [
      sdkModule!.defineTool('list_app_skills', {
        description: APP_SKILL_LIST_DESC,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        handler: async () => (await runBridgeTool('app_skill.list', {})).text,
        skipPermission: true,
      }),
      sdkModule!.defineTool('get_app_skill', {
        description: APP_SKILL_GET_DESC,
        parameters: { type: 'object', properties: { name: { type: 'string', description: 'skill folder name from list_app_skills' } }, required: ['name'], additionalProperties: false },
        handler: async (args: any) => (await runBridgeTool('app_skill.get', { name: args?.name })).text,
        skipPermission: true,
      }),
      sdkModule!.defineTool('create_app_skill', {
        description: APP_SKILL_CREATE_DESC,
        parameters: { type: 'object', properties: { content: { type: 'string', description: 'full SKILL.md (frontmatter name+description + body)' } }, required: ['content'], additionalProperties: false },
        handler: async (args: any) => (await runBridgeTool('app_skill.create', { content: args?.content })).text,
      }),
      sdkModule!.defineTool('update_app_skill', {
        description: APP_SKILL_UPDATE_DESC,
        parameters: { type: 'object', properties: { name: { type: 'string', description: 'current skill folder name' }, content: { type: 'string', description: 'full new SKILL.md' } }, required: ['name', 'content'], additionalProperties: false },
        handler: async (args: any) => (await runBridgeTool('app_skill.update', { name: args?.name, content: args?.content })).text,
      }),
      // skipPermission: the gate lives downstream in main's handleAppTool (a
      // generic per-origin web-permission popup, provider-agnostic). Skipping the
      // copilot tool prompt avoids a double prompt; the downstream gate still runs.
      sdkModule!.defineTool(WEB_FETCH_TOOL, {
        description: WEB_FETCH_DESC,
        parameters: { type: 'object', properties: {
          url: { type: 'string', description: 'absolute http(s) URL of the internal service' },
          method: { type: 'string', description: 'HTTP method (default GET)' },
          headers: { type: 'object', description: 'extra request headers, e.g. {"kbn-xsrf":"true"}' },
          body: { type: 'string', description: 'request body, e.g. a JSON query string' },
        }, required: ['url'], additionalProperties: false },
        handler: async (args: any) => (await runBridgeTool('web.fetch', { url: args?.url, method: args?.method, headers: args?.headers, body: args?.body })).text,
        skipPermission: true,
      }),
    ];

    let session: import('@github/copilot-sdk').CopilotSession;
    if (state.cliSessionId) {
      try {
        session = await client.resumeSession(state.cliSessionId, config);
      } catch (err: any) {
        // Stale / expired sessionId is expected; SDK auth or RPC errors are not.
        // Log so we can tell the difference when the user reports "no history
        // restored after restart".
        serverLog('error', 'copilot', 'resumeSession failed; falling back to createSession', { sessionId: state.cliSessionId, message: err?.message ?? err });
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

    // Elicitation handler: bridge Copilot SDK's session.ui.* /
    // session.ui.elicitation requests to our picker_request channel. URL
    // mode (OAuth-style external auth) is not wired in v1 — declined with
    // a console warning. See agent-ui#3 for the design.
    session.registerElicitationHandler(async (ctx) => {
      if (ctx.mode === 'url') {
        serverLog('warn', 'copilot', 'URL-mode elicitation not supported; declining', {
          url: ctx.url, source: ctx.elicitationSource,
        });
        return { action: 'decline' };
      }
      const schema = ctx.requestedSchema;
      const mapped = schema ? elicitationSchemaToPrompts(schema) : null;
      if (!mapped) {
        serverLog('warn', 'copilot', 'elicitation has no usable schema; declining', { message: ctx.message });
        return { action: 'decline' };
      }
      const pickerId = `pk-${randomUUID().slice(0, 8)}`;
      currentSend?.({ type: 'picker_request', id: pickerId, prompts: mapped.prompts });
      const resolved = await new Promise<PickerResolvePayload>((resolve) => {
        pendingPickers.set(pickerId, resolve);
      });
      if ('cancelled' in resolved) return { action: 'cancel' };
      return { action: 'accept', content: picksToElicitationContent(mapped.fields, resolved.answers) };
    });

    // If user already picked a non-default mode before this session existed, apply it.
    // Note: bypassPermissions has its own short-circuit in onPermissionRequest,
    // so even if this rpc.mode.set silently fails, bypass still works.
    const sdkMode = MODE_TO_SDK[currentPermissionMode];
    if (sdkMode && sdkMode !== 'interactive') {
      try {
        await (session as any).rpc.mode.set({ mode: sdkMode });
      } catch (err: any) {
        // For bypass mode our onPermissionRequest short-circuit makes this
        // failure harmless. For plan/default we'd silently be in interactive,
        // which IS user-visible — log so we know.
        serverLog('error', 'copilot', 'rpc.mode.set failed; user may be in interactive mode despite picked', { sdkMode, message: err?.message ?? err });
      }
    }

    // Wire events to send fn. Copilot CLI's built-in tools (read_file, edit, bash, etc.)
    // are used directly; we don't register custom tools.
    session.on((event: any) => {
      if (!currentSend) return;
      diagTraceCopilotToolEvent(event);
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
            currentSend({ type: 'message', msgId, msgType: 'reply', content: event.data.content });
            currentTextMsgId = null;  // Reset for the next text block in this turn.
          }
          break;
        case 'assistant.reasoning':
          if (event.data?.content) {
            const msgId = currentThinkingMsgId ?? mintMsgId();
            currentSend({
              type: 'message', msgId, msgType: 'fold_text',
              label: 'Thinking',
              body: { content: event.data.content, tone: 'muted' },
            });
            currentThinkingMsgId = null;
          }
          break;
        case 'tool.execution_start': {
          const toolName = event.data?.toolName ?? 'unknown';
          const args = event.data?.arguments ?? {};
          const toolUseId = event.data?.toolCallId ?? '';

          // `task_complete` is end-of-turn signal — args.summary carries the
          // assistant's final reply. Render as reply, skip matching result.
          if (toolName === 'task_complete') {
            const text = args.summary ?? args.text ?? args.message ?? args.content ?? '';
            if (text) currentSend({ type: 'message', msgId: mintMsgId(), msgType: 'reply', content: text });
            break;
          }

          // `report_intent` announces "I'm about to do X" — render as `note`.
          // Renderer adds the leading `▸` marker; provider sends pure content.
          if (toolName === 'report_intent') {
            if (typeof args.intent === 'string' && args.intent.length > 0) {
              currentSend({ type: 'message', msgId: mintMsgId(), msgType: 'note', content: args.intent });
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
                if (spec.kind === 'update') {
                  currentSend({
                    type: 'message', msgId, msgType: 'fold_diff',
                    label: 'Edit',
                    subtitle: stripCwd(spec.filePath, currentCwd ?? ''),
                  });
                } else {
                  currentSend({
                    type: 'message', msgId, msgType: 'fold_code',
                    label: 'Add',
                    subtitle: stripCwd(spec.filePath, currentCwd ?? ''),
                  });
                }
              }
              break;
            }
            // Parser refused. Two known-OK cases: Delete File (we don't
            // support yet — see parseApplyPatch:164) and missing Begin/End
            // markers in totally unrelated content. Anything else is a
            // format drift worth diagnosing. Log so the raw preview tells us
            // which case we hit without having to repro live.
            if (!/\*\*\*\s+Delete\s+File:/.test(args)) {
              serverLog('error', 'copilot', 'parseApplyPatch refused non-Delete content; falling back to raw display', { argsPreview: args.slice(0, 300) });
            }
          }

          // Generic tool_use path → fold_code. For apply_patch fallback
          // (multi-hunk / multi-file / Delete that parseApplyPatch refused),
          // wrap the raw string into a one-shot `{ patch }` object so the
          // formatter has something to chew on — output will be the raw patch
          // text, ugly but not lost.
          const argObj: Record<string, unknown> = typeof args === 'string'
            ? { patch: args }
            : args;
          const input = formatCopilotToolInput(toolName, argObj, currentCwd ?? '');
          inflightToolUses.set(toolUseId, { kind: 'tool_use', toolName, input });
          currentSend({
            type: 'message', msgId: toolUseId, msgType: 'fold_code',
            label: toolName,
            subtitle: input,
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
          const cwd = currentCwd ?? '';
          if (entry.kind === 'file_edit') {
            if (entry.diff) {
              currentSend({
                type: 'message', msgId: toolUseId, msgType: 'fold_diff',
                label: 'Edit',
                subtitle: stripCwd(entry.filePath, cwd),
                ...(isError
                  ? { errorMessage: data.error?.message ?? 'edit failed' }
                  : { body: { diff: entry.diff } }),
              });
            } else {
              currentSend({
                type: 'message', msgId: toolUseId, msgType: 'fold_code',
                label: 'Write',
                subtitle: stripCwd(entry.filePath, cwd),
                ...(entry.content !== undefined ? { body: { content: entry.content } } : {}),
                ...(isError ? { errorMessage: data.error?.message ?? 'edit failed' } : {}),
              });
            }
          } else if (entry.kind === 'apply_patch') {
            // Patch-level success/failure applies to every sub-card. SDK
            // doesn't tell us which file caused failure (and apply_patch is
            // typically all-or-nothing — validation fails before any write),
            // so we mark every sub-card with the same result.
            //
            // Per-card error text intentionally stays generic ("apply_patch
            // failed") — repeating the detailed SDK reason on N cards is
            // visual noise; the top-level error message below carries the
            // patch-level reason in detail.
            const detailMsg = data.error?.message ?? 'unknown error';
            for (const { msgId, spec } of entry.subs) {
              if (spec.kind === 'update') {
                currentSend({
                  type: 'message', msgId, msgType: 'fold_diff',
                  label: 'Edit',
                  subtitle: stripCwd(spec.filePath, cwd),
                  ...(isError
                    ? { errorMessage: 'apply_patch failed' }
                    : { body: { diff: spec.diff } }),
                });
              } else {
                currentSend({
                  type: 'message', msgId, msgType: 'fold_code',
                  label: 'Add',
                  subtitle: stripCwd(spec.filePath, cwd),
                  body: { content: spec.content },
                  ...(isError ? { errorMessage: 'apply_patch failed' } : {}),
                });
              }
            }
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
              ? (data.error?.message ?? 'tool failed')
              : (data.result?.content ?? '');
            currentSend({
              type: 'message', msgId: toolUseId, msgType: 'fold_code',
              label: entry.toolName,
              subtitle: entry.input,
              body: { content: String(text).slice(0, 8000) },
              ...(isError ? { errorMessage: 'Tool returned an error' } : {}),
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
        case 'session.skills_loaded':
          // Snapshot the loaded skills for /skills (init-once; reconnect re-emits).
          loadedSkills = Array.isArray(event.data?.skills) ? event.data.skills : [];
          break;
        case 'session.mcp_servers_loaded':
          // Snapshot the loaded MCP servers for /mcp (init-once; reconnect re-emits).
          loadedMcpServers = Array.isArray(event.data?.servers) ? event.data.servers : [];
          break;
        case 'session.plan_changed':
          // Debounced fetch — multiple rapid changes coalesce into one read.
          schedulePlanRead();
          break;
        case 'session.background_tasks_changed':
          // Empty-payload ping → re-fetch the authoritative task list (debounced).
          scheduleTaskRead();
          break;
        case 'system.notification':
          // agent_completed / agent_idle / shell_completed / shell_detached_completed
          // change task state without a background_tasks_changed — refresh the list
          // so completion lands. Other kinds (inbox/instruction) are harmless no-ops.
          scheduleTaskRead();
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
        default:
          // Known-benign lifecycle types are knowingly ignored (see the set
          // above). Only a genuinely NEW/unknown type warns — once — so real
          // SDK drift (an event we ought to render) is visible without spamming
          // the benign ones every turn. See background-tasks#5.
          if (typeof event?.type === 'string'
            && !KNOWN_IGNORED_COPILOT_EVENTS.has(event.type)
            && !seenUnhandledCopilotEvents.has(event.type)) {
            seenUnhandledCopilotEvents.add(event.type);
            serverLog('warn', 'copilot', 'unrecognized session event type — not rendered (first occurrence)', { type: event.type });
          }
      }
    });
    return session;
  }

  /**
   * Cold-start fill of the /mcp /skills snapshot when the user runs the slash
   * before sending any message. The skills_loaded / mcp_servers_loaded events
   * fire on the first TURN, not on bare session creation — so in the cold-start
   * window (no message sent yet) they never arrive. Instead of waiting on events,
   * PULL the listings directly via the session RPC (`mcp.list()` / `skills.list()`,
   * deterministic). The events still keep the snapshot fresh on later turns /
   * reconnect. Idempotent — no-op once both snapshots are in; per-listing so a
   * partial event fill is completed. Best-effort: a failed pull leaves the
   * snapshot unset and the slash reports a load failure (fail-loud).
   */
  async function ensureLoadedContext(): Promise<void> {
    if (loadedSkills !== undefined && loadedMcpServers !== undefined) return;
    let session: import('@github/copilot-sdk').CopilotSession;
    try {
      session = await ensureSession();
    } catch (err: any) {
      serverLog('error', 'copilot', 'ensureLoadedContext: ensureSession failed', err?.message ?? err);
      return;
    }
    const rpc = (session as any).rpc;
    if (loadedMcpServers === undefined) {
      try {
        const res = await rpc.mcp.list();
        loadedMcpServers = Array.isArray(res?.servers) ? res.servers : [];
      } catch (err: any) {
        serverLog('error', 'copilot', 'ensureLoadedContext: mcp.list() failed', err?.message ?? err);
      }
    }
    if (loadedSkills === undefined) {
      try {
        const res = await rpc.skills.list();
        loadedSkills = Array.isArray(res?.skills) ? res.skills : [];
      } catch (err: any) {
        serverLog('error', 'copilot', 'ensureLoadedContext: skills.list() failed', err?.message ?? err);
      }
    }
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
          type: 'plan',
          content: result?.exists ? (result.content ?? '') : '',
        });
      } catch (err: any) {
        // Polled on every plan_changed event (debounced 150ms). Failure means
        // plan panel won't update — could be transient (mid-rebuild) or a
        // breaking SDK change. Logging gives us the diagnosis path.
        serverLog('error', 'copilot', 'rpc.plan.read failed; plan panel may be stale', err?.message ?? err);
      }
    }, 150);
  }

  // Background tasks (background-tasks#2). Unlike claude (task_* system messages in
  // the turn stream), copilot signals list changes via `session.background_tasks_changed`
  // and `system.notification` events — we (debounced) re-fetch the authoritative
  // list via rpc.tasks.list() and emit a turnId-less `task_event` snapshot.
  // currentSend is never nulled, so this works even when a backgrounded task
  // settles between turns; task_event is turnId-exempt → routed via onTaskEvent.
  let taskReadTimer: NodeJS.Timeout | null = null;
  function scheduleTaskRead() {
    if (taskReadTimer) return;
    taskReadTimer = setTimeout(async () => {
      taskReadTimer = null;
      if (!state.session || !currentSend) return;
      try {
        const list = await (state.session as any).rpc.tasks.list();
        const tasks = (list?.tasks ?? [])
          .filter(isBackgroundedCopilotTask)
          .map(normalizeCopilotTask)
          .filter((t: unknown): t is NonNullable<typeof t> => t !== null);
        currentSend({ type: 'task_event', kind: 'snapshot', tasks });
      } catch (err: any) {
        serverLog('error', 'copilot', 'rpc.tasks.list failed; task panel may be stale', err?.message ?? err);
      }
    }, 150);
  }

  // Turn-end safety net: finalize any tool cards still in-flight when the turn
  // settled (idle / error / abort). Their `tool.execution_complete` never came
  // — the Copilot CLI's rg/grep tool can hang internally and never return,
  // leaving the card spinning forever with no error (fail-silent). Emit a loud
  // terminal card per orphan so the spinner resolves, then clear the map. No-op
  // when nothing is in flight (the common case).
  function finalizeOrphanedToolCards(send: SendFn): void {
    if (inflightToolUses.size === 0) return;
    const entries = [...inflightToolUses];
    inflightToolUses.clear();
    serverLog('warn', 'copilot', 'finalizing orphaned tool cards (turn ended, no tool.execution_complete) '
      + JSON.stringify({ count: entries.length, ids: entries.map(([id]) => id) }));
    const msgs = buildOrphanFinalizeMessages(
      entries,
      currentCwd ?? '',
      'Tool did not complete — the turn ended while it was still running (it may have hung).',
    );
    for (const m of msgs) send({ type: 'message', ...m });
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
    const label = `/${cmd}`;
    // Provider-side helpers — wire shape uses fold_markdown:
    //  - pending: no body, no errorMessage (renderer shows running indicator)
    //  - success: body present (markdown content)
    //  - error:   errorMessage present; body optional when there's extra detail
    const emitPending = (msgId: string) => {
      send({ type: 'message', msgId, msgType: 'fold_markdown', label });
    };
    const emitSuccess = (msgId: string, content: string) => {
      send({ type: 'message', msgId, msgType: 'fold_markdown', label, body: { content } });
    };
    const emitError = (msgId: string, errorMessage: string, content?: string) => {
      send({
        type: 'message', msgId, msgType: 'fold_markdown', label,
        errorMessage,
        ...(content ? { body: { content } } : {}),
      });
    };
    // Config edits (model/effort/permission) are status transitions, not slash
    // content — render them as a centered `system` divider via the shared
    // formatConfigAck, matching Claude's applyConfigEdit. Failures still surface
    // as a plain `error` message with the SDK's reason.
    const emitConfigAck = (key: ConfigEditKey, value: string) => {
      send({ type: 'message', msgId: mintMsgId(), msgType: 'system', content: formatConfigAck(key, value) });
    };
    const emitConfigError = (reason: string) => {
      send({ type: 'message', msgId: mintMsgId(), msgType: 'error', content: reason });
    };

    switch (cmd) {
      case 'help': {
        const msgId = mintMsgId();
        const lines = SLASH_COMMANDS.map((c) => `- /${c.name} — ${c.description}`).join('\n');
        emitSuccess(msgId, `Available commands:\n${lines}`);
        return;
      }

      // /mcp /skills: read-only listing, emitted as a plain `reply`. Snapshot is
      // filled by the loaded events (later turns) or pulled on cold-start via
      // ensureLoadedContext.
      //
      // The in-process Shelf bridge is registered as `config.tools` (NOT an MCP
      // server in Copilot's model), so it never appears in `mcp.list()`. Surface
      // it explicitly — with its tools — for usability + parity with Claude
      // (where the SDK reports it as the in-process `shelf` MCP server). Always
      // shown; a failed real-server pull adds a fail-loud note but never hides
      // the bridge. See skills#3 / agent-providers#6.
      case 'mcp': {
        await ensureLoadedContext();
        const shelf = { name: 'shelf', status: 'connected', source: 'in-process', tools: SHELF_BRIDGE_TOOLS };
        const servers = [...(loadedMcpServers ?? []), shelf];
        let content = formatCopilotMcpCard(servers);
        if (loadedMcpServers === undefined) content += '\n\n_Could not load configured MCP servers (showing the built-in bridge only)._';
        send({ type: 'message', msgId: mintMsgId(), msgType: 'reply', content });
        return;
      }
      case 'skills': {
        await ensureLoadedContext();
        const content = loadedSkills === undefined
          ? 'Could not load the skills list — the session failed to initialize.'
          : formatCopilotSkillsCard(loadedSkills);
        send({ type: 'message', msgId: mintMsgId(), msgType: 'reply', content });
        return;
      }

      case 'context': {
        const msgId = mintMsgId();
        emitPending(msgId);
        if (!latestUsage) {
          emitError(msgId, 'No context info yet. Send a message first.');
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
        emitSuccess(msgId, lines.join('\n'));
        return;
      }

      case 'compact': {
        const msgId = mintMsgId();
        emitPending(msgId);
        if (!state.session) {
          emitError(msgId, 'No active session to compact.');
          return;
        }
        try {
          await critical(async () => {
            const result = await (state.session as any).rpc.history.compact();
            if (!result?.success) {
              emitError(msgId, 'Compaction failed');
              return;
            }
            const removed = result.tokensRemoved?.toLocaleString() ?? '?';
            const msgs = result.messagesRemoved ?? 0;
            emitSuccess(msgId, `Compacted: freed ${removed} tokens across ${msgs} messages.`);
          });
        } catch (err: any) {
          emitError(msgId, `Compact failed: ${err?.message ?? err}`);
        }
        return;
      }

      case 'clear': {
        const msgId = mintMsgId();
        emitPending(msgId);
        try {
          await critical(async () => {
            const hadSession = !!state.session || !!state.cliSessionId;
            try {
              await state.session?.disconnect();
            } catch (err: any) {
              serverLog('error', 'copilot', 'session.disconnect() failed during /clear rebuild', err?.message ?? err);
            }
            state.session = null;
            state.cliSessionId = null;
            latestUsage = null;
            inflightToolUses.clear();
            send({ type: 'context_patch', patch: { lastSdkSessionId: null } });
            send({ type: 'plan', content: '' });
            if (hadSession) {
              try {
                await ensureSession();
              } catch (err: any) {
                emitError(msgId, `Cleared, but failed to start new session: ${err?.message ?? err}`);
                return;
              }
            }
            emitSuccess(msgId, 'Context cleared');
          });
        } catch (err: any) {
          emitError(msgId, `Clear failed: ${err?.message ?? err}`);
        }
        return;
      }

      // Renderer dispatches /model /effort /permission here when the user
      // types them with args (without args opens a renderer-side picker
      // from capabilities). Provider is the single source of truth for
      // whether the switch took effect — we apply imperatively against
      // the session and emit a fold_markdown pending → success/error
      // card just like /help, /clear, etc. After success we also
      // re-broadcast capabilities so the renderer's actualModel updates
      // (and its capability-driven persist effect saves to projectConfig).
      case 'model': {
        if (!args) {
          emitConfigError('Usage: /model <model-id>');
          return;
        }
        try {
          if (state.session) {
            const supported = effortsFor(args);
            const nextEffort = currentEffort && supported.includes(currentEffort)
              ? currentEffort
              : modelMeta(args)?.defaultReasoningEffort;
            await state.session.setModel(
              args,
              nextEffort ? { reasoningEffort: nextEffort as any } : undefined,
            );
            currentEffort = nextEffort;
          }
          // closure update only after SDK accepted — if setModel throws,
          // currentModel stays consistent with the active session.
          currentModel = args;
          currentSend?.({ type: 'capabilities', ...buildCapabilities() });
          emitConfigAck('model', args);
        } catch (err: any) {
          emitConfigError(`Failed to switch model: ${err?.message ?? err}`);
        }
        return;
      }

      case 'effort': {
        if (!args) {
          emitConfigError('Usage: /effort <level>');
          return;
        }
        try {
          if (state.session) {
            await state.session.setModel(currentModel, { reasoningEffort: args as any });
          }
          currentEffort = args;
          currentSend?.({ type: 'capabilities', ...buildCapabilities() });
          emitConfigAck('effort', args);
        } catch (err: any) {
          emitConfigError(`Failed to set effort: ${err?.message ?? err}`);
        }
        return;
      }

      case 'permission': {
        if (!args) {
          emitConfigError('Usage: /permission <mode>');
          return;
        }
        // Translate our shared app vocab (PermissionModeId) → Copilot SDK's
        // session mode. No mapping = no SDK action we can take for this value
        // (invalid, or a valid app mode Copilot doesn't support e.g.
        // acceptEdits) — report it rather than silently claiming success.
        const sdkMode = MODE_TO_SDK[args];
        if (!sdkMode) {
          emitConfigError(`Unknown permission mode "${args}". Valid: ${Object.keys(MODE_TO_SDK).join(', ')}`);
          return;
        }
        try {
          if (state.session) {
            await (state.session as any).rpc.mode.set({ mode: sdkMode });
          }
          currentPermissionMode = args;
          currentSend?.({ type: 'capabilities', ...buildCapabilities() });
          emitConfigAck('permissionMode', args);
        } catch (err: any) {
          emitConfigError(`Failed to set permission mode: ${err?.message ?? err}`);
        }
        return;
      }

      default: {
        const msgId = mintMsgId();
        emitError(msgId, `Unknown command: /${cmd}`);
        return;
      }
    }
  }

  return {
    async gatherCapabilities(
      _cwd: string,
      sessionId?: string,
      _customModels?: ProviderModel[],
      intent?: { model?: string; effort?: string; permissionMode?: string },
    ): Promise<ProviderCapabilities> {
      // Copilot SDK validates model names against GitHub's model API; user-provided
      // custom IDs would be rejected at runtime, so we ignore customModels here.
      if (sessionId) currentSessionId = sessionId;
      // Auth probe (provider-internal detail). Copilot exposes a first-class
      // getAuthStatus() → { isAuthenticated }, so unlike Claude we need no
      // warmup/heuristic — but the SHARED contract is still just `authRequired`
      // on caps; main/renderer stay provider-agnostic. A probe error is treated
      // as unknown (don't block the pane); a real failure still surfaces
      // mid-turn via query()'s auth_required emit.
      let authRequired = false;
      try {
        const client = await ensureClient();
        const status = await client.getAuthStatus();
        authRequired = !status.isAuthenticated;
      } catch (err: any) {
        serverLog('error', 'copilot', 'getAuthStatus failed; treating as unknown (not blocking)', err?.message ?? err);
      }
      // listModels hits the GitHub model API — only fetch when authed. Logged
      // out it would throw/hang, and AuthPane covers the pane anyway.
      if (!authRequired) await listModelsCached();
      // Seed closures from renderer's saved intent BEFORE buildCapabilities so
      // the first `currentPermissionMode` (and model/effort) the renderer sees
      // after a reconnect matches projectConfig.agentPrefs instead of the
      // hardcoded provider defaults. No `session.setX` calls — state.session
      // doesn't exist yet at this point; the closure values flow into
      // createSession config on the next query() turn.
      if (intent?.model) currentModel = intent.model;
      if (intent?.effort) currentEffort = intent.effort;
      if (intent?.permissionMode) currentPermissionMode = intent.permissionMode;
      if (!currentEffort) currentEffort = modelMeta(currentModel)?.defaultReasoningEffort;
      return { ...buildCapabilities(), authRequired };
    },

    async query(input: QueryInput, send: SendFn) {
      currentSend = send;
      // Reset per-turn streaming msgId state — prior turn's leftover would
      // otherwise let chunks from this turn attach to a stale msgId.
      currentTextMsgId = null;
      currentThinkingMsgId = null;

      // Capture cwd / appId up front (first value wins) so they land in the
      // createSession config — including when a cold-start /mcp /skills slash
      // calls ensureSession via ensureLoadedContext below, BEFORE any real turn.
      if (input.cwd && !currentCwd) currentCwd = input.cwd;
      if (input.appId && !currentAppId) currentAppId = input.appId;

      // Slash / config-edit detection. Both bypass normal SDK setup and route
      // to dispatchSlash:
      //   - typed `/model X` etc. → parseSlashPrefix(prompt)
      //   - structured config-edit turn (picker / status-bar) → input.configEdit
      //     with an empty prompt. Without handling this explicitly the empty
      //     prompt falls through to a normal SDK send, silently continuing the
      //     conversation and never applying the change or emitting a card.
      // Converges both entry points onto one imperative apply (agent-config-flow#5).
      // configEdit.key 'permissionMode' maps to the '/permission' slash.
      const slash = input.configEdit
        ? { cmd: input.configEdit.key === 'permissionMode' ? 'permission' : input.configEdit.key, args: input.configEdit.value }
        : parseSlashPrefix(input.prompt);
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
      // cwd / appId already captured at the top of query() (first value wins).
      // Copilot CLI has no rpc.cwd.set, so a mid-session cwd change doesn't
      // recreate the session — most users stay in one project per session.

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
      } finally {
        // Runs on every turn-end path (success / error / timeout / abort): any
        // tool card still in-flight here never got its completion → finalize it
        // so the UI never shows an eternal spinner.
        finalizeOrphanedToolCards(send);
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
      try {
        await state.session?.abort();
      } catch (err: any) {
        serverLog('error', 'copilot', 'session.abort() failed during stop()', err?.message ?? err);
      }
    },

    dispose() {
      try {
        state.session?.disconnect();
      } catch (err: any) {
        serverLog('error', 'copilot', 'session.disconnect() failed during dispose()', err?.message ?? err);
      }
      try {
        state.client?.stop();
      } catch (err: any) {
        serverLog('error', 'copilot', 'client.stop() failed during dispose()', err?.message ?? err);
      }
      state.session = null;
      state.client = null;
    },

    resetSession(_sessionId: string) {
      // Drop in-memory session refs so the next query() starts a fresh CLI
      // session instead of trying to resume from a now-deleted lastSdkSessionId.
      // Disconnect best-effort; the live session is being abandoned anyway.
      try {
        state.session?.disconnect();
      } catch (err: any) {
        serverLog('error', 'copilot', 'session.disconnect() failed during resetSession', err?.message ?? err);
      }
      state.session = null;
      state.cliSessionId = null;
      latestUsage = null;
      inflightToolUses.clear();
    },

    async readTaskOutput(taskId: string): Promise<string> {
      if (!state.session) throw new Error('No active Copilot session');
      const list = await (state.session as any).rpc.tasks.list();
      const task = (list?.tasks ?? []).find((t: any) => t?.id === taskId);
      if (!task) {
        // DIAGNOSTIC: a carded task can't be found in the live task list. Likely a
        // stale card from a previous session / provider switch, or an id mismatch.
        // Log the known ids so we can see what the list DID contain.
        serverLog('warn', 'copilot', 'readTaskOutput: task not found ' + JSON.stringify({ task_id: taskId, known_ids: (list?.tasks ?? []).map((t: any) => t?.id) }));
        throw new Error(`No task ${taskId}`);
      }
      // Shell tasks write a detached log file (read it ON the remote — main/
      // renderer never touch remote fs). Agent tasks carry their output inline.
      if (task.type === 'shell') {
        if (typeof task.logPath !== 'string' || !task.logPath) {
          serverLog('warn', 'copilot', 'readTaskOutput: shell task has no logPath ' + JSON.stringify({ task_id: taskId, status: task.status }));
          throw new Error('Task has no log file');
        }
        const MAX = 256 * 1024;
        const buf = await fs.promises.readFile(task.logPath);
        if (buf.length > MAX) {
          return buf.subarray(buf.length - MAX).toString('utf8')
            + `\n\n… (truncated — showing last ${MAX / 1024}KB of ${Math.round(buf.length / 1024)}KB)`;
        }
        return buf.toString('utf8');
      }
      if (task.result == null && task.latestResponse == null) {
        serverLog('warn', 'copilot', 'readTaskOutput: non-shell task has no inline result ' + JSON.stringify({ task_id: taskId, type: task.type, status: task.status }));
      }
      return task.result ?? task.latestResponse ?? '(no output)';
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
     * Re-scan the session's configured skillDirectories (our projected app-skill
     * dir among them) so an app-level skill edit is live without re-init. Uses
     * the SDK's experimental `rpc.skills.reload()` — the programmatic twin of the
     * CLI `/skills reload`. Best-effort: no live session → nothing to reload; an
     * SDK/RPC failure logs and leaves the current snapshot (change still lands on
     * next session init). Takes effect from the session's next turn.
     */
    async reloadSkills() {
      const session = state.session;
      if (!session) {
        serverLog('warn', 'copilot', 'reloadSkills: no live session — app-skill edit will apply on next session init');
        return { reloaded: false, ok: true };
      }
      try {
        await (session as any).rpc.skills.reload();
        // Experimental SDK API — log success so a dev build can confirm the
        // reload actually fired (and re-scanned our skillDirectories) for the
        // live session, not just that we called it. See skills#4.
        serverLog('warn', 'copilot', 'skills.reload() applied — app-skill edit now live for this session (effective next turn)');
        return { reloaded: true, ok: true };
      } catch (err: any) {
        serverLog('warn', 'copilot', 'skills.reload() failed; app-skill edit will apply on next session init instead', err?.message ?? err);
        return { reloaded: true, ok: false, error: err?.message ?? String(err) };
      }
    },

    /**
     * Apply model to the current Copilot session. Imperative — orchestrator
     * decides when to call (only on diff). Effort comes along because
     * `session.setModel` takes it as the second-arg config; effort fallback
     * to model's default if currently unsupported.
     *
     * Closure mutation is deferred until after the SDK accepts the change.
     * If `session.setModel` throws (invalid model id, etc.), `currentModel`
     * and `currentEffort` stay consistent with the active session — otherwise
     * later status / capabilities events would broadcast a model that's
     * different from what the session actually runs.
     */
    async setModel(model: string) {
      const supported = effortsFor(model);
      const nextEffort = currentEffort && supported.includes(currentEffort)
        ? currentEffort
        : modelMeta(model)?.defaultReasoningEffort;
      if (state.session) {
        await state.session.setModel(model, nextEffort ? { reasoningEffort: nextEffort as any } : undefined);
      }
      currentModel = model;
      currentEffort = nextEffort;
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
