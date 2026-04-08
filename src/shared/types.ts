// ── Connection types ──

export type LocalConnection = { type: 'local' };
export type SSHConnection = { type: 'ssh'; host: string; port: number; user: string };
export type WSLConnection = { type: 'wsl'; distro: string };
export type Connection = LocalConnection | SSHConnection | WSLConnection;

// ── Project config (persisted) ──

export interface ProjectConfig {
  id: string;
  name: string;
  cwd: string;
  connection: Connection;
  maxTabs: number;
  initScript?: string;
}

// ── IPC payloads: Renderer → Main ──

export interface PtySpawnPayload {
  projectId: string;
  tabId: string;
  cwd: string;
  connection: Connection;
  initScript?: string;
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

export interface FolderListPayload {
  path: string;
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
  | 'closeProject'
  | 'newTab'
  | 'prevProject'
  | 'nextProject'
  | 'prevTab'
  | 'nextTab'
  | 'openSettings'
  | 'search'
  | 'toggleSplit';

export type KeybindingConfig = Record<KeybindingAction, string>;

export interface AppSettings {
  fontSize: number;
  fontFamily: string;
  themeName: string;
  scrollback: number;
  defaultMaxTabs: number;
  keybindings: KeybindingConfig;
}


export interface SSHListDirPayload {
  host: string;
  port: number;
  user: string;
  path: string;
}

// ── FolderPicker ──

export interface FolderListResult {
  path: string;
  entries: string[];
  error?: string;
}
