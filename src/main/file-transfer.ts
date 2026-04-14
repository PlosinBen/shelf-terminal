import type { Connection } from '../shared/types';
import { createConnector } from './connector';
import { log } from '../shared/logger';

/**
 * Generic file uploader for paste/drag-drop. Routes through the appropriate
 * connector so the renderer doesn't need to know about ssh/docker/wsl plumbing.
 *
 * Files land at `<projectCwd>/.tmp/shelf/<prefix>-<filename>`.
 */

export const SESSION_STARTED_AT = Date.now();

export async function uploadFile(
  connection: Connection,
  cwd: string,
  filename: string,
  buffer: Buffer,
): Promise<string> {
  log.debug('file-transfer', `upload ${filename} (${buffer.length}B) → ${connection.type}:${cwd}`);
  const connector = createConnector(connection);
  return connector.uploadFile(cwd, filename, buffer);
}

export async function cleanupSession(
  connection: Connection,
  cwd: string,
  cutoffMs: number,
): Promise<number> {
  const connector = createConnector(connection);
  return connector.cleanupSession(cwd, cutoffMs);
}

export async function clearUploads(connection: Connection, cwd: string): Promise<number> {
  const connector = createConnector(connection);
  return connector.clearUploads(cwd);
}

// ── Scheduling ──

const cleanedProjects = new Set<string>();

export function maybeScheduleCleanup(projectId: string, connection: Connection, cwd: string): void {
  if (!projectId || cleanedProjects.has(projectId)) return;
  if (!cwd || cwd.trim() === '' || cwd.trim() === '/') return;
  cleanedProjects.add(projectId);

  setTimeout(() => {
    cleanupSession(connection, cwd, SESSION_STARTED_AT)
      .then((n) => {
        if (n > 0) log.info('file-transfer', `session cleanup removed ${n} stale upload(s) in ${cwd}`);
      })
      .catch((err) => {
        log.info('file-transfer', `session cleanup skipped for ${cwd}: ${err?.message ?? err}`);
      });
  }, 3000);
}

// Test-only hooks
export function __resetCleanupTracking(): void {
  cleanedProjects.clear();
}

// ── Re-export utility functions for unit tests ──
// These are the canonical implementations in connector/file-utils.ts;
// re-exported here so existing test imports continue to work.
import {
  buildPaths,
  sanitizeFilename,
  shellSingleQuote,
  makePrefix,
  parseUploadPrefix,
  assertSafeCwd,
  buildRemoteUploadCmd,
} from './connector/file-utils';

export const __test__ = {
  buildPaths,
  sanitizeFilename,
  shellSingleQuote,
  makePrefix,
  parseUploadPrefix,
  assertSafeCwd,
  buildRemoteUploadCmd,
};
