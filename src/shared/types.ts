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

export type AgentDisplayMode = 'collapsed' | 'expanded' | 'hidden';

export const AGENT_DISPLAY_KEYS: { key: string; label: string }[] = [
  { key: 'thinking', label: 'Thinking' },
  { key: 'Read', label: 'Read' },
  { key: 'Grep', label: 'Grep' },
  { key: 'Glob', label: 'Glob' },
  { key: 'Bash', label: 'Bash' },
  { key: 'Edit', label: 'Edit' },
  { key: 'Write', label: 'Write' },
  { key: 'other', label: 'Other Tools' },
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
  | 'toggleDevTools';

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
  agentDisplay?: Partial<Record<string, AgentDisplayMode>>;
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
