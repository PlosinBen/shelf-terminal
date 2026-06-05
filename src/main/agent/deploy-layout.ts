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
import type { Libc } from './runtime-target';

/** All possible payload files (the superset; the actual set is libc-dependent). */
export const DEPLOY_FILES = ['node', 'index.mjs', 'claude'] as const;
export type DeployFile = (typeof DEPLOY_FILES)[number];

/**
 * Files we ship for a target. glibc ships our own Node; musl uses the remote's
 * node, so it ships everything EXCEPT node.
 */
export function deployFilesFor(libc: Libc): DeployFile[] {
  return libc === 'musl' ? ['index.mjs', 'claude'] : ['node', 'index.mjs', 'claude'];
}

/** Completion sentinel, written only after every payload file is in place. */
export const DEPLOYED_SENTINEL = '.deployed';

/**
 * Parent dir holding all versioned deploy roots: `<base>/.shelf/agent-server`.
 * `base` is the connection-appropriate home (`~` for ssh where the shell
 * expands it, `/root` for docker). POSIX.
 */
export function agentServerDir(base: string): string {
  return `${base.replace(/\/+$/, '')}/.shelf/agent-server`;
}

/** Versioned remote deploy root: `<base>/.shelf/agent-server/<version>`. POSIX. */
export function deployRoot(base: string, version: string): string {
  return `${agentServerDir(base)}/${version}`;
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

/** Which of the `expected` files still need transferring (empty = none). */
export function missingFiles(inv: RemoteInventory, expected: DeployFile[]): DeployFile[] {
  return expected.filter((f) => !inv.files[f]);
}

/**
 * True if we must (re)deploy: sentinel absent OR any `expected` file missing.
 * When the sentinel is present AND all expected files exist, skip the whole
 * transfer (avoids re-sending the ~215MB Claude binary every reconnect).
 */
export function needsDeploy(inv: RemoteInventory, expected: DeployFile[]): boolean {
  if (!inv.sentinel) return true;
  return missingFiles(inv, expected).length > 0;
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
