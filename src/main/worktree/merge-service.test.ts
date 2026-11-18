import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  get: vi.fn(), inspect: vi.fn(), lifecycle: vi.fn(), exec: vi.fn(), merge: vi.fn(),
}));
vi.mock('../projects/repository-provider', () => ({ getProjectsRepository: () => ({ get: mocks.get }) }));
vi.mock('./reconcile', () => ({ inspectWorktreeSource: mocks.inspect, setWorktreeLifecycle: mocks.lifecycle }));
vi.mock('../connector', () => ({ createConnector: () => ({ exec: mocks.exec }) }));
vi.mock('./merge-back', () => ({ mergeBackFastForward: mocks.merge }));
import { mergeWorktreeProject, mergeBackWithLock } from './merge-service';
import { repoLockKey, tryAcquireRepoLock } from './repo-lock';

const connection = { type: 'local' as const };
const base = { id: 'base', cwd: '/repo', connection };
const child = { id: 'child', parentProjectId: 'base', cwd: '/child', connection };
const commit = 'a'.repeat(40);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockImplementation(id => id === 'base' ? base : id === 'child' ? child : undefined);
  mocks.inspect.mockResolvedValue({ commit, branch: null });
  mocks.exec.mockResolvedValue({ stdout: '', stderr: '' });
  mocks.merge.mockResolvedValue({ outcome: 'merged' });
});
describe('direct project merge', () => {
  it('awaits merge and returns the inspected detached source, using canonical paths', async () => {
    let finish!: (value: unknown) => void;
    mocks.merge.mockImplementation(() => new Promise(r => { finish = r; }));
    const pending = mergeWorktreeProject('child', 'main');
    await vi.waitFor(() => expect(mocks.merge).toHaveBeenCalled());
    expect(mocks.lifecycle).toHaveBeenCalledExactlyOnceWith('base', true);
    expect(mocks.merge.mock.calls[0][0]).toMatchObject({
      featureCwd: '/child', baseCwd: '/repo', baseBranch: 'main', featureBranch: '', sourceCommit: commit,
    });
    finish({ outcome: 'merged' });
    expect(await pending).toEqual({ outcome: 'merged', sourceCommit: commit, targetBranch: 'main' });
    expect(mocks.lifecycle).toHaveBeenLastCalledWith('base', false);
  });
  it.each(['non-ff', 'feature-dirty', 'base-dirty', 'error'])('preserves %s and Git diagnostics', async outcome => {
    mocks.merge.mockResolvedValue({ outcome, error: 'git stderr' });
    expect(await mergeWorktreeProject('child', 'main')).toEqual({ outcome, error: 'git stderr', sourceCommit: commit, targetBranch: 'main' });
    expect(mocks.lifecycle).toHaveBeenLastCalledWith('base', false);
  });
  it.each([undefined, 'unknown', 'base'])('rejects an invalid caller %s without Git', async id => {
    expect(await mergeWorktreeProject(id, 'main')).toMatchObject({ outcome: 'error' });
    expect(mocks.merge).not.toHaveBeenCalled();
  });
  it('rejects missing parent, unavailable child and failed live identity inspection', async () => {
    mocks.get.mockImplementation(id => id === 'child' ? child : undefined);
    expect(await mergeWorktreeProject('child', 'main')).toMatchObject({ outcome: 'error' });
    mocks.get.mockImplementation(id => id === 'base' ? base : { ...child, worktreeState: { availability: 'missing' } });
    expect(await mergeWorktreeProject('child', 'main')).toMatchObject({ outcome: 'error' });
    mocks.get.mockImplementation(id => id === 'base' ? base : child);
    mocks.inspect.mockRejectedValue(new Error('identity mismatch'));
    expect(await mergeWorktreeProject('child', 'main')).toMatchObject({ outcome: 'error', error: 'identity mismatch' });
    expect(mocks.merge).not.toHaveBeenCalled();
  });
  it.each(['', 'bad..ref', 'missing'])('rejects invalid/missing target %s without merge', async target => {
    mocks.exec.mockRejectedValue(new Error('invalid or missing ref'));
    expect(await mergeWorktreeProject('child', target)).toMatchObject({ outcome: 'error' });
    expect(mocks.merge).not.toHaveBeenCalled();
  });
  it('shares the UI repo lock and releases lifecycle after busy', async () => {
    const release = tryAcquireRepoLock(repoLockKey(connection, '/repo'))!;
    try {
      expect(await mergeWorktreeProject('child', 'main')).toMatchObject({ outcome: 'busy' });
      expect(mocks.merge).not.toHaveBeenCalled();
      expect(mocks.lifecycle).toHaveBeenLastCalledWith('base', false);
    } finally { release(); }
    expect(await mergeWorktreeProject('child', 'main')).toMatchObject({ outcome: 'merged' });
  });
  it('does not release another operation’s lifecycle', async () => {
    mocks.lifecycle.mockImplementation(() => { throw new Error('Another worktree operation is in progress'); });
    expect(await mergeWorktreeProject('child', 'main')).toMatchObject({ outcome: 'busy' });
    expect(mocks.lifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.merge).not.toHaveBeenCalled();
  });
  it('rejects a channel that closes during inspection before mutating Git', async () => {
    expect(await mergeWorktreeProject('child', 'main', () => false)).toMatchObject({ outcome: 'error', error: expect.stringContaining('Inactive') });
    expect(mocks.merge).not.toHaveBeenCalled();
  });
  it('releases the shared lock when connector/merge fails', async () => {
    mocks.merge.mockRejectedValueOnce(new Error('transport lost; outcome unknown'));
    const params = { connection, featureCwd: '/child', baseCwd: '/repo', baseBranch: 'main', featureBranch: 'feature' };
    expect(await mergeBackWithLock(params)).toMatchObject({ outcome: 'error', error: expect.stringContaining('outcome unknown') });
    expect(await mergeBackWithLock(params)).toMatchObject({ outcome: 'merged' });
  });
});
