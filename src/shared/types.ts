// ── Agent types ──

export type AgentProvider = 'claude' | 'copilot' | 'gemini';
export type TabType = 'terminal' | 'agent';

export type AuthMethod =
  | { kind: 'api-key'; envVar: string; setupUrl?: string; placeholder?: string }
  | { kind: 'oauth'; instructions: Array<{ label: string; command?: string }> }
  | { kind: 'sdk-managed'; instructions: Array<{ label: string; command?: string }> }
  | { kind: 'none' };

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

export interface AgentPrefs {
  model?: string;
  effort?: string;
  permissionMode?: string;
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
  dockerPath?: string;
  unicode11?: boolean;
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

// ── Auto-updater ──

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number; transferred: number; total: number }
  | { state: 'downloaded'; version: string };
