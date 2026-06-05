// ── Agent types ──

export type AgentProvider = 'claude' | 'copilot';
export type TabType = 'terminal' | 'agent';

export type AuthMethod =
  | { kind: 'api-key'; envVar: string; setupUrl?: string; placeholder?: string }
  | { kind: 'oauth'; instructions: Array<{ label: string; command?: string }> }
  | { kind: 'sdk-managed'; instructions: Array<{ label: string; command?: string }> }
  | { kind: 'none' };

export interface AgentPrefs {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

/**
 * A file attachment on a user message. `path` is the canonical / absolute
 * path; `displayPath` is the basename or short-form for chip rendering.
 */
export interface AgentFile {
  path: string;
  displayPath: string;
}

/**
 * Universal upsert key for the renderer's message store. Provider mints it
 * (see `agent-server/providers/*` for `mintMsgId()`). Stream chunks and
 * their finalize message share one msgId so the renderer accumulates them
 * into a single timeline entry.
 *
 * `streaming?` flag indicates an entry is still receiving delta chunks
 * (only set on `reply` / `fold_text` — other variants never stream). UI
 * uses it to render the blinking cursor at the end of body content and
 * to suppress promotion to "completed" rendering until a finalize lands.
 */
type WithMsgId = { msgId: string; streaming?: boolean };

/**
 * Shared header shape for all `fold_*` variants. Provider supplies the full
 * subtitle string (no upstream truncation); renderer handles CSS-level
 * ellipsis + `title={subtitle}` tooltip on hover.
 *
 * `errorMessage`: when present, the card is treated as failed — renderer
 * shows a red banner and force-expands regardless of the user's display
 * setting. `body` may be undefined (pure failure) or present (failed with
 * partial output — e.g. Bash exit 1 with stderr text).
 */
export interface FoldBase {
  label: string;
  subtitle?: string;
  errorMessage?: string;
}

/**
 * Canonical agent message types — single source of truth shared across
 * agent-server (provider translation), main (IPC bridge), and renderer (UI).
 * Discriminated union: each variant carries exactly the fields it needs.
 *
 * Naming is purely rendering-oriented (no provider semantics leak in):
 *   - `reply`: assistant's primary markdown reply (streams).
 *   - `note`: one-line dim italic inline note (Copilot report_intent etc).
 *     Renderer renders the leading `▸` marker — provider sends pure content.
 *   - `system`: framework / SDK-level inline notification.
 *   - `error`: inline red error (provider-business layer errors).
 *   - `fold_text`: collapsible block, body is plain wrapped text (reasoning,
 *     prose output). Streams. body.tone='muted' renders dim.
 *   - `fold_code`: collapsible block, monospace `<pre>` body (shell stdout,
 *     file contents). Markdown intentionally NOT parsed.
 *   - `fold_markdown`: collapsible block, body is rendered markdown
 *     (slash command output, MCP rich text, anything wanting ```fence```).
 *   - `fold_diff`: collapsible block, side-by-side diff body.
 *   - `user`: user-typed message (NEVER emitted by providers — renderer-only).
 *
 * `plan` is NOT in this union — it's transported via its own AgentEvent /
 * IPC channel and lands in `agentTabStore.currentPlan`, not the timeline.
 *
 * See `.agent/features/agent-message-type-refactor.md` for design rationale.
 */
export type AgentMessage = WithMsgId & (
  | { type: 'reply';   content: string }
  | { type: 'note';    content: string }
  | { type: 'system';  content: string }
  | { type: 'error';   content: string }
  | (FoldBase & { type: 'fold_text';     body?: { content: string; tone?: 'muted' } })
  | (FoldBase & { type: 'fold_code';     body?: { content: string } })
  | (FoldBase & { type: 'fold_markdown'; body?: { content: string } })
  | (FoldBase & { type: 'fold_diff';     body?: { diff: { oldString: string; newString: string } } })
  | { type: 'user';    content: string; images?: string[]; files?: AgentFile[] }
);

export type AgentMessageType = AgentMessage['type'];

/**
 * Backend lifecycle hint sent from main to renderer right after `agent:init`.
 * Renderer uses it to show a "Starting agent…" spinner and a retry path when
 * spawn / capability load fails (e.g. agent-server bundle missing, node not
 * on PATH, deploy step errors over SSH).
 */
/**
 * Sub-phase of the `starting` state, refining the spinner text during a
 * (sometimes slow) remote tab-open: 'deploying' (first-run runtime copy,
 * ~200MB), 'connecting' (spawn + await-ready), 'checking-auth' (the SDK init
 * auth probe). Undefined → generic "Starting agent…".
 */
export type AgentInitPhase = 'deploying' | 'connecting' | 'checking-auth';

export type AgentInitStatus =
  | { state: 'starting'; phase?: AgentInitPhase }
  | { state: 'ready' }
  | { state: 'failed'; reason: string };

export type AgentDisplayMode = 'collapsed' | 'expanded';

/**
 * Per-fold-type display preference key. 1:1 mapping with the `fold_*` variants
 * of `AgentMessage` — no separate mapping layer. `reply` / `note` / `system` /
 * `error` / `user` always render (no setting); failed fold cards
 * (`errorMessage` set) always force-expand regardless of these settings.
 */
export type AgentDisplayKey =
  | 'fold_text'      // default collapsed (reasoning, prose)
  | 'fold_code'      // default collapsed (raw output, monospace, no markdown)
  | 'fold_markdown'  // default expanded (markdown structure)
  | 'fold_diff';     // default expanded (file diff)

export const AGENT_DISPLAY_KEYS: { key: AgentDisplayKey; label: string; hint?: string }[] = [
  { key: 'fold_text',     label: 'Plain Text',
    hint: 'Wrapped text content (reasoning, prose output). Default collapsed.' },
  { key: 'fold_code',     label: 'Raw Output',
    hint: 'Monospace text with preserved whitespace, no markdown parsing (shell output, file contents). Default collapsed.' },
  { key: 'fold_markdown', label: 'Markdown',
    hint: 'Rendered markdown — lists, tables, code fences (```json / ```ts), links. Default expanded.' },
  { key: 'fold_diff',     label: 'File Diff',
    hint: 'Side-by-side diff (file edits). Default expanded.' },
];

/**
 * Per-fold-key default display mode — the SINGLE source of truth shared by the
 * renderer (AgentMessage's render fallback) and the Settings panel (dropdown
 * fallback value). These MUST match: a hardcoded mismatch previously made the
 * Settings dropdown show "Collapsed" for Markdown while messages actually
 * rendered expanded, because each side fell back to a different default.
 */
export const DEFAULT_AGENT_DISPLAY: Record<AgentDisplayKey, AgentDisplayMode> = {
  fold_text: 'collapsed',
  fold_code: 'collapsed',
  fold_markdown: 'expanded',
  fold_diff: 'expanded',
};

// ── Connection types ──

export type LocalConnection = { type: 'local' };
export type SSHConnection = { type: 'ssh'; host: string; port: number; user: string; password?: string };
export type WSLConnection = { type: 'wsl'; distro: string };
export type DockerConnection = { type: 'docker'; container: string };
export type Connection = LocalConnection | SSHConnection | WSLConnection | DockerConnection;

// ── Project config (persisted) ──

export interface TabTemplate {
  name: string;
  cmd?: string;
  color?: string;
}

export interface QuickCommand {
  label: string;
  command: string;
  target: 'current' | string; // 'current' = active tab, or tab name
}

export interface ProjectConfig {
  id: string;
  name: string;
  cwd: string;
  connection: Connection;
  maxTabs: number;
  initScript?: string;
  defaultTabs?: TabTemplate[];
  quickCommands?: QuickCommand[];
  parentProjectId?: string;
  worktreeBranch?: string;
  defaultAgentProvider?: AgentProvider;
  openAgentOnConnect?: boolean;
  agentSessionIds?: Partial<Record<AgentProvider, string>>;
  agentPrefs?: Partial<Record<AgentProvider, AgentPrefs>>;
}

// ── IPC payloads: Renderer → Main ──

export interface PtySpawnPayload {
  projectId: string;
  tabId: string;
  cwd: string;
  connection: Connection;
  initScript?: string;
  tabCmd?: string;
}

export interface PtyInputPayload {
  tabId: string;
  data: string;
}

export interface PtyResizePayload {
  tabId: string;
  cols: number;
  rows: number;
}

export interface PtyKillPayload {
  tabId: string;
}

// ── IPC payloads: Main → Renderer ──

export interface PtyDataPayload {
  tabId: string;
  data: string;
}

export interface PtyExitPayload {
  tabId: string;
  exitCode: number;
}

// ── App settings (persisted) ──

export type KeybindingAction =
  | 'toggleProjectList'
  | 'newProject'
  | 'removeProject'
  | 'newTab'
  | 'prevProject'
  | 'nextProject'
  | 'prevTab'
  | 'nextTab'
  | 'openSettings'
  | 'search'
  | 'toggleSplitRight'
  | 'openCommandPicker'
  | 'toggleDevTools'
  | 'toggleNotes'
  | 'togglePm'
  | 'quickNote';

export type KeybindingConfig = Record<KeybindingAction, string>;

export type LogLevel = 'off' | 'error' | 'info' | 'debug';

export interface AppSettings {
  fontSize: number;
  fontFamily: string;
  themeName: string;
  scrollback: number;
  defaultMaxTabs: number;
  keybindings: KeybindingConfig;
  logLevel: LogLevel;
  maxUploadSizeMB: number;
  defaultLocalPath?: string;
  unicode11?: boolean;
  pmProvider?: PmProviderConfig;
  telegram?: TelegramConfig;
  /** Persisted PM Active (telegram listener) on/off intent. Restored at launch
   *  (start if true + telegram configured). Toggled via PM_SET_ACTIVE, and
   *  auto-set false when the listener stops on a fatal/conflict error. */
  pmActive?: boolean;
  agentDisplay?: Partial<Record<AgentDisplayKey, AgentDisplayMode>>;
  /** Max UI messages kept in memory per agent tab. Controls render perf
   *  (and indirectly React reconciliation cost). IDB no longer has a
   *  separate cap — history is unbounded on disk and we load only the
   *  latest `inMemoryMax` rows on tab open. */
  agentInMemoryMaxMessages: number;
  /** How long (ms) to coalesce dirty writes before flushing to IDB.
   *  Lower = less data lost on crash, higher = fewer IDB transactions. */
  agentHistorySaveThrottleMs: number;
  providerModels?: Partial<Record<PmProviderType | 'claude', ProviderModel[]>>;
}


// ── FolderPicker ──

export interface FolderListResult {
  path: string;
  entries: string[];
  error?: string;
}

// ── File upload (paste/drag) ──

export type FileUploadResult =
  | { ok: true; remotePath: string }
  | { ok: false; reason: string };

export type FileClearResult =
  | { ok: true; removed: number }
  | { ok: false; reason: string };

// ── Git / Worktree ──

export interface GitBranchInfo {
  name: string;
  current: boolean;
  worktreePath?: string;
}

export interface WorktreeAddResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface WorktreeRemoveResult {
  ok: boolean;
  error?: string;
}

// ── PM Agent ──

export type PmProviderType = 'openai' | 'gemini' | 'ollama';

export interface ProviderModel {
  id: string;
  /** Optional — dynamically-discovered models (e.g. ollama) don't carry this.
   *  Renderer should render `(<N>K)` only when present. */
  contextWindow?: number;
  reasoning?: boolean;
}

export interface PmProviderMeta {
  id: PmProviderType;
  label: string;
  baseURL?: string;
  defaultModel: string;
  models: ProviderModel[];
  /** When true, SettingsPanel calls `pm.listModels(baseURL)` and merges the
   *  result with user-defined custom entries. See DECISIONS-pm #65. */
  dynamicModelList?: boolean;
}

export const PM_PROVIDERS: PmProviderMeta[] = [
  {
    id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o',
    models: [
      { id: 'gpt-4o', contextWindow: 128000 },
      { id: 'gpt-4o-mini', contextWindow: 128000 },
      { id: 'gpt-4.1', contextWindow: 1047576 },
      { id: 'gpt-4.1-mini', contextWindow: 1047576 },
      { id: 'gpt-4.1-nano', contextWindow: 1047576 },
      { id: 'o3', contextWindow: 200000, reasoning: true },
      { id: 'o4-mini', contextWindow: 200000, reasoning: true },
    ],
  },
  {
    id: 'gemini', label: 'Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-flash', contextWindow: 1048576, reasoning: true },
      { id: 'gemini-2.5-pro', contextWindow: 1048576, reasoning: true },
      { id: 'gemini-2.0-flash', contextWindow: 1048576 },
    ],
  },
  {
    id: 'ollama', label: 'Ollama (local)', baseURL: 'http://localhost:11434/v1', defaultModel: 'qwen3:8b',
    models: [],
    dynamicModelList: true,
  },
];

/**
 * Agent providers that accept user-defined custom models. Copilot is excluded —
 * its SDK validates model IDs against GitHub's API and would reject custom entries.
 * See agent-server/providers/copilot.ts gatherCapabilities.
 */
export const AGENT_PROVIDER_REGISTRY: { id: 'claude'; label: string; models: ProviderModel[] }[] = [
  { id: 'claude', label: 'Claude', models: [] },
];

export function getModelsForProvider(providerType: PmProviderType, custom?: Partial<Record<PmProviderType, ProviderModel[]>>): ProviderModel[] {
  const defaults = PM_PROVIDERS.find((p) => p.id === providerType)?.models ?? [];
  const overrides = custom?.[providerType];
  if (!overrides || overrides.length === 0) return defaults;
  const merged = [...defaults];
  for (const o of overrides) {
    const idx = merged.findIndex((m) => m.id === o.id);
    if (idx >= 0) merged[idx] = o;
    else merged.push(o);
  }
  return merged;
}

export interface PmProviderConfig {
  provider: PmProviderType;
  apiKey: string;
  model: string;
  /** Optional override of the provider's default baseURL. Used by ollama
   *  (remote server) and any self-hosted OpenAI-compatible endpoint.
   *  See DECISIONS-pm #65. */
  baseURL?: string;
}

/** IPC `pm:listModels` response. `unreachable` = connection refused / DNS fail;
 *  `timeout` = server didn't respond in time; `parse_error` = response shape
 *  not OpenAI-compatible (e.g. wrong URL pointed at a non-OpenAI server). */
export type PmListModelsResult =
  | { ok: true; models: ProviderModel[] }
  | { ok: false; error: 'unreachable' | 'timeout' | 'parse_error' };

export type TabInferredState =
  | 'idle_shell'
  | 'cli_running'
  | 'cli_waiting_input'
  | 'cli_waiting_permission'
  | 'cli_error'
  | 'cli_done';

export interface TabScanResult {
  projectId: string;
  projectName: string;
  tabId: string;
  tabName: string;
  lastLines: string;
  inferredState: TabInferredState;
}

export interface PmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

export interface PmMessage {
  role: 'user' | 'assistant' | 'error';
  content: string;
  toolCalls?: PmToolCall[];
  timestamp: number;
}

export interface PmStreamChunk {
  type: 'text' | 'tool_start' | 'tool_result' | 'done' | 'error' | 'escalation';
  text?: string;
  toolCall?: PmToolCall;
  error?: string;
  escalation?: PmEscalation;
}

export interface PmEscalation {
  tabId: string;
  projectName: string;
  tabName: string;
  reason: string;
  scrollbackSnippet: string;
  action: 'approve' | 'deny' | 'dismiss';
}

// ── Telegram ──

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

// ── Auto-updater ──

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number; transferred: number; total: number }
  | { state: 'downloaded'; version: string };
