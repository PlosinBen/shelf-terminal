import { describe, it, expect, vi } from 'vitest';
import { scanWorktrees } from './scan';
import type { WorktreeProbe } from '../connector/worktree-probe';
const main = { checkoutPath: '/main', gitDir: '/main/.git', commonDir: '/main/.git' };
const child = { checkoutPath: '/child', gitDir: '/main/.git/worktrees/child', commonDir: '/main/.git' };
const list = `worktree /main\0HEAD ${'a'.repeat(40)}\0branch refs/heads/main\0\0worktree /child\0HEAD ${'a'.repeat(40)}\0detached\0\0`;
const probe = (identity: ReturnType<typeof vi.fn>, git = vi.fn().mockResolvedValue(list)) => ({ identity, git }) as unknown as WorktreeProbe;
describe('worktree snapshot', () => {
  it('excludes main by identity and retains detached candidates', async () => {
    const result = await scanWorktrees(probe(vi.fn(async (p) => p === '/child' ? child : main)), '/main/sub');
    expect(result?.branch).toBe('main');
    expect(result?.worktrees).toEqual([{ path: '/child', head: 'a'.repeat(40), branch: null, bare: false, identity: child }]);
  });
  it('does not re-add registrations whose checkout is missing', async () => {
    expect((await scanWorktrees(probe(vi.fn(async (p) => p === '/child' ? null : main)), '/main'))?.worktrees).toEqual([]);
  });
  it('rejects changed snapshots and inaccessible candidates', async () => {
    await expect(scanWorktrees(probe(vi.fn().mockResolvedValue(main), vi.fn().mockResolvedValueOnce(list).mockResolvedValue('changed')), '/main')).rejects.toThrow();
    await expect(scanWorktrees(probe(vi.fn().mockResolvedValueOnce(main).mockRejectedValue(new Error('permission'))), '/main')).rejects.toThrow('permission');
  });
});
