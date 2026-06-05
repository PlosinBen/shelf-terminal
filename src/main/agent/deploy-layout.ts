/**
 * Deploy layout + incremental-deploy decision (R1, Phase 1.0).
 *
 * Remote layout (the "complete set" we ship — bring our own runtime, never
 * detect the remote's installed CLI):
 *
 *   <base>/.shelf/agent-server/<version>/
 *     node          ← our pinned Node binary (arch×libc specific)
 *     index.mjs     ← agent-server bundle
 *     claude        ← our Claude CLI binary (arch×libc specific)
 *     .deployed     ← written LAST, only after all files land (completion sentinel)
 *
 * The sentinel is the last write so a half-finished transfer (network drop
 * mid-215MB) is never mistaken for "already deployed" — `needsDeploy` requires
 * BOTH the sentinel AND every payload file.
 *
 * IMPORTANT: remote paths are always POSIX (`/`). The host may be Windows
 * (Win→WSL/SSH), so we must NOT use path.join for remote paths — that would
 * emit backslashes. Host-side cache paths DO use path.join (host-appropriate).
 */

import * as path from 'path';

/** Payload files that must all be present for a deploy to count as complete. */
export const DEPLOY_FILES = ['node', 'index.mjs', 'claude'] as const;
export type DeployFile = (typeof DEPLOY_FILES)[number];

/** Completion sentinel, written only after every payload file is in place. */
export const DEPLOYED_SENTINEL = '.deployed';

/**
 * Versioned remote deploy root. `base` is the connection-appropriate home
 * (e.g. `~` for ssh where the shell expands it, `/root` for docker). POSIX.
 */
export function deployRoot(base: string, version: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/.shelf/agent-server/${version}`;
}

/** Absolute (POSIX) remote path of a deployed file under the versioned root. */
export function remoteFilePath(base: string, version: string, file: string): string {
  return `${deployRoot(base, version)}/${file}`;
}

/** Map of "does this path exist on the remote" for sentinel + payload files. */
export interface RemoteInventory {
  sentinel: boolean;
  files: Partial<Record<DeployFile, boolean>>;
}

/** Which payload files still need transferring (empty = none). */
export function missingFiles(inv: RemoteInventory): DeployFile[] {
  return DEPLOY_FILES.filter((f) => !inv.files[f]);
}

/**
 * True if we must (re)deploy: sentinel absent OR any payload file missing.
 * When the sentinel is present AND all files exist, skip the whole transfer
 * (avoids re-sending the ~215MB Claude binary every reconnect).
 */
export function needsDeploy(inv: RemoteInventory): boolean {
  if (!inv.sentinel) return true;
  return missingFiles(inv).length > 0;
}

// ── Host-side cache (per arch×libc, under userData; app stays slim) ──

/** `<userData>/runtime-cache/<targetId>` — host path, host separators. */
export function cacheDir(userData: string, targetId: string): string {
  return path.join(userData, 'runtime-cache', targetId);
}

/** Cached, extracted Node directory for a target+version. */
export function cachedNodeDir(userData: string, targetId: string, nodeArchiveName: string): string {
  return path.join(cacheDir(userData, targetId), nodeArchiveName);
}

/** Cached Node binary (the executable we actually ship). */
export function cachedNodeBin(userData: string, targetId: string, nodeArchiveName: string): string {
  return path.join(cachedNodeDir(userData, targetId, nodeArchiveName), 'bin', 'node');
}

/** Cached Claude binary for a target+sdkVersion. */
export function cachedClaudeBin(userData: string, targetId: string, sdkVersion: string): string {
  return path.join(cacheDir(userData, targetId), `claude-${sdkVersion}`, 'claude');
}
