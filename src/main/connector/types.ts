import type { FolderListResult } from '@shared/types';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { EnvMap } from '@shared/project-env';

/** An ordinary target process, not an interactive terminal or an SSH session. */
export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: EnvMap;
  requiredEnv?: EnvMap;
  /** Remote POSIX shell setup, before cwd/env/exec; local launches execute directly. */
  initScript?: string;
}

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
  /** Strict home lookup for writes: rejects instead of returning picker fallbacks. */
  resolveHomePath(): Promise<string>;
  /** Copy a local file to an absolute target path; caller creates the parent directory. */
  copyFile(localPath: string, targetPath: string): Promise<void>;
  /** Pipe stdio with native process error/exit events; caller owns process lifetime. */
  spawnProcess(request: ProcessRequest): ChildProcessWithoutNullStreams;
  // ── Shell ──
  /**
   * Spawn an interactive shell. `env` is the project-level env map (plain, later
   * + secret) to inject: local connectors merge it into the pty's `env` (PATH
   * merges); remote connectors (docker/ssh/wsl) prepend an `export …` prefix to
   * the launched command, since the pty `env` only reaches the local ssh/docker
   * client, not the remote shell. Reserved project keys are dropped;
   * `requiredEnv` is applied last for Shelf-owned process boundaries. Absent →
   * no injection.
   */
  createShell(
    cwd: string,
    env?: Record<string, string>,
    requiredEnv?: Record<string, string>,
  ): Shell;

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
  /**
   * Generic placement: write `buffer` to an ABSOLUTE path on the target,
   * mkdir-ing parents. Used by the transport primitive (type-declared placement)
   * for control-plane files like `~/.shelf/apps/<id>/mcp-servers.json` — distinct
   * from uploadFile, which is hardwired to `<cwd>/.tmp/shelf/`. See
   * features/app-level-mcps.
   */
  putFile(remotePath: string, buffer: Buffer): Promise<void>;
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
