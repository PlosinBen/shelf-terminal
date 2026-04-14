import type { FolderListResult } from '../../shared/types';

export interface Disposable {
  dispose(): void;
}

/** Connector-returned shell session. Consumers never import node-pty directly. */
export interface Shell {
  onData(cb: (data: string) => void): Disposable;
  onExit(cb: (exitCode: number) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface Connector {
  // ── Shell ──
  createShell(cwd: string): Shell;

  // ── Connection lifecycle ──
  isConnected(): Promise<boolean>;
  connect(password?: string): Promise<void>;

  // ── File system ──
  listDir(dirPath: string): Promise<FolderListResult>;
  homePath(): Promise<string>;

  // ── File transfer ──
  uploadFile(cwd: string, filename: string, buffer: Buffer): Promise<string>;
  cleanupSession(cwd: string, cutoffMs: number): Promise<number>;
  clearUploads(cwd: string): Promise<number>;
}
