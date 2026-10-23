import { it, expect } from 'vitest';
import { mapWorktrees } from './mapping';
import type { Project } from '@shared/projects';
const identity = { checkoutPath: '/child', gitDir: '/main/.git/worktrees/child', commonDir: '/main/.git' };
const candidate = { path: '/child', head: 'a'.repeat(40), branch: null, bare: false, identity };
it('preserves existing settings and session when branch becomes detached', () => {
  const child = { id: 'id', cwd: '/child/sub', baseBranch: 'release', agentSessionIds: { fake: 'session' }, worktreeBranch: 'feature' } as unknown as Project;
  const result = mapWorktrees([child], new Map([['id', identity]]), [candidate]);
  expect(result.additions).toEqual([]);
  expect(result.updates[0]).toMatchObject({ id: 'id', cwd: '/child/sub', baseBranch: 'release', agentSessionIds: { fake: 'session' }, worktreeBranch: null, worktreeState: { availability: 'valid', identity } });
  expect(mapWorktrees(result.updates, new Map([['id', null]]), []).updates[0].worktreeState).toEqual({ availability: 'missing', identity });
});
it('rejects duplicate existing mappings instead of merging user data', () => {
  const children = [{ id: 'a', cwd: '/child' }, { id: 'b', cwd: '/child' }] as Project[];
  expect(() => mapWorktrees(children, new Map(), [candidate])).toThrow('Ambiguous');
});
