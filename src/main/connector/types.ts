import type { FolderListResult } from '@shared/types';

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

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface Connector {
  // ── Shell ──
  createShell(cwd: string): Shell;

  // ── Connection lifecycle ──
  isConnected(): Promise<boolean>;
  connect(password?: string): Promise<void>;

  // ── Command execution ──
  exec(cwd: string, cmd: string): Promise<ExecResult>;

  // ── File system ──
  listDir(dirPath: string): Promise<FolderListResult>;
  homePath(): Promise<string>;

  // ── File transfer ──
  uploadFile(cwd: string, filename: string, buffer: Buffer): Promise<string>;
  cleanupSession(cwd: string, cutoffMs: number): Promise<number>;
  clearUploads(cwd: string): Promise<number>;
  /**
   * Total bytes + file count under `<cwd>/.tmp/shelf/`. Powers the "Uploaded
   * Files: X MB · N files" display in Project Edit. Returns zeros on any
   * failure (missing dir, no permission, remote unreachable) — caller can't
   * meaningfully distinguish "0 bytes" from "couldn't read", and `0 B` is
   * also the post-Clear display, so the UI is uniform.
   */
  getUploadsSize(cwd: string): Promise<{ totalBytes: number; fileCount: number }>;
}
