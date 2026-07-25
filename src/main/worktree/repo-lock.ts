import type { Connection } from '@shared/types';
import { normalizeCwd } from '../connector/file-utils';

/**
 * Per-repo serialization lock for worktree `finish`.
 *
 * `finish` must make "check main hasn't moved → fast-forward push" atomic per
 * repo: only one feature may merge back into a given base repo at a time. The
 * lock is main-process in-memory (the ff push is executed by main, so lock and
 * protected action sit on the same side — naturally atomic, no persistence).
 *
 * Try-acquire semantics, NOT blocking: a caller that loses the race gets an
 * immediate "busy" (null), never a hidden wait. The agent/user picks the retry
 * moment (fail-loud, consistent). Different repos never block each other.
 */

const held = new Set<string>();

/** Identity of the base repo a worktree merges back into: connection + cwd. */
export function repoLockKey(connection: Connection, cwd: string): string {
  return `${connectionKey(connection)}::${normalizeCwd(cwd)}`;
}

function connectionKey(c: Connection): string {
  switch (c.type) {
    case 'local': return 'local';
    case 'ssh': return `ssh:${c.user}@${c.host}:${c.port}`;
    case 'wsl': return `wsl:${c.distro ?? ''}`;
    case 'docker': return `docker:${c.container}`;
    default: {
      // Fail-loud on an unmodelled connection type rather than silently colliding
      // two repos under one key (which would wrongly serialize unrelated finishes).
      const exhaustive: never = c;
      return `unknown:${JSON.stringify(exhaustive)}`;
    }
  }
}

/**
 * Try to take the lock for `key`. Returns a one-shot release fn on success, or
 * `null` if another finish already holds it (caller returns "busy" immediately).
 */
export function tryAcquireRepoLock(key: string): (() => void) | null {
  if (held.has(key)) return null;
  held.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(key);
  };
}

/** Test-only: is this key currently held? */
export function isRepoLockHeld(key: string): boolean {
  return held.has(key);
}
