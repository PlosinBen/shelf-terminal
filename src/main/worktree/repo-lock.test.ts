import { describe, it, expect } from 'vitest';
import { repoLockKey, tryAcquireRepoLock, isRepoLockHeld } from './repo-lock';
import type { Connection } from '@shared/types';

const local: Connection = { type: 'local' };

describe('repoLockKey', () => {
  it('same connection + cwd → same key (trailing slash normalized)', () => {
    expect(repoLockKey(local, '/repo')).toBe(repoLockKey(local, '/repo/'));
  });

  it('different cwd → different key', () => {
    expect(repoLockKey(local, '/repo-a')).not.toBe(repoLockKey(local, '/repo-b'));
  });

  it('different connection → different key', () => {
    const ssh: Connection = { type: 'ssh', host: 'h', port: 22, user: 'u' };
    expect(repoLockKey(local, '/repo')).not.toBe(repoLockKey(ssh, '/repo'));
  });
});

describe('tryAcquireRepoLock', () => {
  it('first acquire succeeds; second on same key is busy (null)', () => {
    const key = repoLockKey(local, '/repo-lock-1');
    const release = tryAcquireRepoLock(key);
    expect(release).not.toBeNull();
    expect(tryAcquireRepoLock(key)).toBeNull();
    release!();
  });

  it('release frees the key for re-acquisition', () => {
    const key = repoLockKey(local, '/repo-lock-2');
    const release = tryAcquireRepoLock(key)!;
    release();
    expect(isRepoLockHeld(key)).toBe(false);
    const again = tryAcquireRepoLock(key);
    expect(again).not.toBeNull();
    again!();
  });

  it('release is idempotent — a double release cannot free a re-acquired lock', () => {
    const key = repoLockKey(local, '/repo-lock-3');
    const release = tryAcquireRepoLock(key)!;
    release();
    // Someone else acquires it now…
    const other = tryAcquireRepoLock(key)!;
    // …a stale double-release from the first holder must NOT free the other's lock.
    release();
    expect(isRepoLockHeld(key)).toBe(true);
    other();
    expect(isRepoLockHeld(key)).toBe(false);
  });

  it('different repos do not block each other', () => {
    const a = tryAcquireRepoLock(repoLockKey(local, '/repo-x'));
    const b = tryAcquireRepoLock(repoLockKey(local, '/repo-y'));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    a!(); b!();
  });
});
