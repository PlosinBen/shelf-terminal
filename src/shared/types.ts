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
 * Canonical agent message types — single source of truth shared across
 * agent-server (provider translation), main (IPC bridge), and renderer (UI).
 * Discriminated union: each variant carries exactly the fields it needs.
 *
 * Wire ↔ renderer contract:
 * - `tool_use` and `file_edit` carry a `toolUseId`; renderer upserts on this
 *   id so a `tool.execution_complete` event arriving as a second `tool_use`
 *   message replaces the original (now with `result` populated).
 * - `result?` absent ⇒ pending; present ⇒ completed (success or error).
 * - `plan` is consumed by a sticky panel before the message stream — never
 *   reaches the per-message render switch.
 *
 * See `.agent/features/AGENT_VIEW_MSG_TYPE.md` for design rationale.
 */
/**
 * Universal upsert key for the renderer's message store. Provider mints it
 * (see `agent-server/providers/*` for `mintMsgId()`). Stream chunks and
 * their finalize message share one msgId so the renderer accumulates them
 * into a single timeline entry. For tool_use / file_edit, `msgId ===
 * toolUseId` — they're the same identity, both fields preserved for
 * clarity (toolUseId stays named because permission_request pairs by it).
 *
 * `streaming?` flag indicates an entry is still receiving delta chunks
 * (only set on text/thinking — other variants never stream). UI uses it
 * to render the blinking cursor and to suppress promotion to "completed"
 * rendering until a finalize message lands or the turn ends.
 */
type WithMsgId = { msgId: string; streaming?: boolean };

export type AgentMessage = WithMsgId & (
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'intent'; content: string }
  | { type: 'system'; content: string }
  | { type: 'error'; content: string }
  | { type: 'plan'; content: string }
  | {
      type: 'tool_use';
      toolUseId: string;  // === msgId
      toolName: string;
      // Provider-formatted, human-readable input string. Renderer treats it
      // as opaque text — no toolName-sniffing, no JSON parsing. Truncation
      // for header display is a renderer-side CSS concern.
      input: string;
      result?: { content: string; isError?: boolean };
    }
  | {
      type: 'file_edit';
      toolUseId: string;  // === msgId
      filePath: string;
      diff?: { oldString: string; newString: string };
      content?: string;
      result?: { success: boolean; error?: string };
    }
  | {
      /**
       * Provider-emitted response to a slash command. Renderer is opaque to
       * `slashCmd` — only `status` drives styling (pending indicator / success
       * / error). `content` is provider-preformatted text, renderer just shows
       * it. Complex output (context tables, progress bars, etc.) belongs in
       * dedicated message types — slash_response stays a narrow status carrier.
       *
       * Upsert by msgId: provider emits `pending` first, then `success`/`error`
       * with the same msgId. Persistence revives orphan pending (no terminal
       * status landed before close) as a synthetic `error` so reload doesn't
       * show a fake-pending entry.
       */
      type: 'slash_response';
      slashCmd: string;
      status: 'pending' | 'success' | 'error';
      content: string;
    }
);

export type AgentMessageType = AgentMessage['type'];

/**
 * Backend lifecycle hint sent from main to renderer right after `agent:init`.
 * Renderer uses it to show a "Starting agent…" spinner and a retry path when
 * spawn / capability load fails (e.g. agent-server bundle missing, node not
 * on PATH, deploy step errors over SSH).
 */
export type AgentInitStatus =
  | { state: 'starting' }
  | { state: 'ready' }
  | { state: 'failed'; reason: string };

export type AgentDisplayMode = 'collapsed' | 'expanded' | 'hidden';

/**
 * Canonical settings keys for per-message-type display preferences.
 * Aligns with `AgentMessage` union — provider-specific toolName (Bash / bash /
 * view / Read / …) no longer leaks into settings. Adding a new SDK tool only
 * touches provider formatters; settings are stable.
 *
 * Notes:
 * - `tool_use` covers all non-file-edit tools (Read/Grep/Glob/Bash/view/task/...)
 * - `file_edit` covers Edit/Write/apply_patch (translated to `file_edit`
 *   canonical type by providers)
 * - `intent` is Copilot's `report_intent` predictive line; expanded/collapsed
 *   are visually identical (it's always a one-liner) — only `hidden` is
 *   meaningful, but we keep the 3-way select for UI consistency
 * - `text` / `system` / `error` are intentionally NOT here — hiding them would
 *   break the conversation; they always render
 */
export type AgentDisplayKey = 'thinking' | 'tool_use' | 'file_edit' | 'intent';

export const AGENT_DISPLAY_KEYS: { key: AgentDisplayKey; label: string; hint?: string }[] = [
  { key: 'thinking',  label: 'Thinking',  hint: 'Reasoning blocks (Claude thinking / Copilot reasoning)' },
  { key: 'tool_use',  label: 'Tool Use',  hint: 'Read / Grep / Glob / Bash / view / Task / WebFetch / etc. Errors always show regardless of this setting.' },
  { key: 'file_edit', label: 'File Edit', hint: 'Edit / Write / apply_patch. Failed edits always show regardless of this setting.' },
  { key: 'intent',    label: 'Intent',    hint: 'Copilot report_intent predictive lines. Hidden = do not render at all.' },
];

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
  | 'toggleSidebar'
  | 'newProject'
  | 'removeProject'
  | 'newTab'
  | 'prevProject'
  | 'nextProject'
  | 'prevTab'
  | 'nextTab'
  | 'openSettings'
  | 'search'
  | 'toggleSplit'
  | 'openCommandPicker'
  | 'toggleDevTools'
  | 'toggleNotes';

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
  agentDisplay?: Partial<Record<AgentDisplayKey, AgentDisplayMode>>;
  /** Max UI messages persisted per agent session in IndexedDB.
   *  Trimmed at save time; oldest dropped first. */
  agentHistoryMaxMessages: number;
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

export type PmProviderType = 'openai' | 'gemini';

export interface ProviderModel {
  id: string;
  contextWindow: number;
  reasoning?: boolean;
}

export const PM_PROVIDERS: { id: PmProviderType; label: string; baseURL?: string; defaultModel: string; models: ProviderModel[] }[] = [
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
}

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
