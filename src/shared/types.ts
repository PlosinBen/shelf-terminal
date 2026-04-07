// ── Connection types ──

export type LocalConnection = { type: 'local' };
export type SSHConnection = { type: 'ssh'; host: string; port: number; user: string };
export type Connection = LocalConnection | SSHConnection;

// ── Project config (persisted) ──

export interface ProjectConfig {
  id: string;
  name: string;
  cwd: string;
  connection: Connection;
  maxTabs: number;
}

// ── IPC payloads: Renderer → Main ──

export interface PtySpawnPayload {
  projectId: string;
  tabId: string;
  cwd: string;
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

// ── FolderPicker ──

export interface FolderListResult {
  path: string;
  entries: string[];
  error?: string;
}
