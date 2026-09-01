import { randomUUID } from 'crypto';
import type { FolderListResult } from '@shared/types';
import type { ConnectorConfig } from './config';
import type { Connector, ExecResult, Shell } from './types';

export interface RuntimeGeneration {
  readonly id: string;
}

/**
 * Live connector protocol boundary. Its generation is the lifetime key for
 * ephemeral target facts; tabs consume the runtime but do not own it.
 */
export class ConnectorRuntime implements Connector {
  readonly generation: RuntimeGeneration = Object.freeze({ id: randomUUID() });
  private generationCurrent = true;

  constructor(
    readonly config: ConnectorConfig,
    private readonly connector: Connector,
  ) {}

  isCurrentGeneration(): boolean {
    return this.generationCurrent;
  }

  invalidate(): void {
    this.generationCurrent = false;
  }

  createShell(cwd: string, env?: Record<string, string>, requiredEnv?: Record<string, string>): Shell {
    return this.connector.createShell(cwd, env, requiredEnv);
  }

  isConnected(): Promise<boolean> {
    return this.connector.isConnected();
  }

  connect(password?: string): Promise<void> {
    return this.connector.connect(password);
  }

  exec(cwd: string, cmd: string): Promise<ExecResult> {
    return this.connector.exec(cwd, cmd);
  }

  listDir(dirPath: string): Promise<FolderListResult> {
    return this.connector.listDir(dirPath);
  }

  homePath(): Promise<string> {
    return this.connector.homePath();
  }

  uploadFile(cwd: string, filename: string, buffer: Buffer): Promise<string> {
    return this.connector.uploadFile(cwd, filename, buffer);
  }

  putFile(remotePath: string, buffer: Buffer): Promise<void> {
    return this.connector.putFile(remotePath, buffer);
  }

  cleanupSession(cwd: string, cutoffMs: number): Promise<number> {
    return this.connector.cleanupSession(cwd, cutoffMs);
  }

  clearUploads(cwd: string): Promise<number> {
    return this.connector.clearUploads(cwd);
  }

  getUploadsSize(cwd: string): Promise<{ totalBytes: number; fileCount: number }> {
    return this.connector.getUploadsSize(cwd);
  }
}
