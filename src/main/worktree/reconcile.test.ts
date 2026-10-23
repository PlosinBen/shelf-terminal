import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { MainProjectsRepository } from '../projects/projects-repository';
import { createMainProjectsRepository } from '../projects/projects-repository';
import type { Project } from '@shared/projects';
import type { WorktreeSnapshot } from './scan';
const mocks = vi.hoisted(() => ({ probeFacts: vi.fn(), scan: vi.fn(), copy: vi.fn(), remove: vi.fn(), exec: vi.fn(), repository: null as MainProjectsRepository | null }));
vi.mock('../projects/repository-provider', () => ({ getProjectsRepository: () => mocks.repository }));
vi.mock('../connector', () => ({ createConnector: () => ({ exec: mocks.exec, isCurrentGeneration: () => true }) }));
vi.mock('../connector/target-facts', () => ({ TARGET_OS: { windows: 'windows' }, TargetFactsResolver: class { cached?: Promise<unknown>; resolve() { return this.cached ??= mocks.probeFacts(); } } }));
vi.mock('../secret-store', () => ({ copyProjectSecrets: mocks.copy, deleteProjectSecrets: mocks.remove }));
vi.mock('./scan', () => ({ scanWorktrees: mocks.scan }));
import { reconcileWorktrees, setWorktreeLifecycle } from './reconcile';
let id = 0;
let main: Project;
let repository: MainProjectsRepository;
const snapshot: WorktreeSnapshot = {
  main: { checkoutPath: '/main', gitDir: '/main/.git', commonDir: '/main/.git' }, branch: 'main',
  worktrees: [{ path: '/child', head: 'a'.repeat(40), branch: 'feature', bare: false, identity: { checkoutPath: '/child', gitDir: '/main/.git/worktrees/child', commonDir: '/main/.git' } }],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.probeFacts.mockResolvedValue({ ok: true, facts: { targetOS: 'unix' } });
  main = { id: `main-${++id}`, name: 'main', cwd: '/main', connection: { type: 'local' }, maxTabs: 5, initScript: null, envPlain: {}, defaultTabs: [{ name: 'Terminal' }], quickCommands: [], featureNoteDir: null, parentProjectId: null, worktreeBranch: null, baseBranch: null, agentSessionIds: {}, agentPrefs: {} };
  const result = createMainProjectsRepository({ load: () => ({ ok: true, value: [main] }), save: async () => ({ ok: true }) }, () => `child-${id}`, { cleanup: async () => {} });
  if (!result.ok) throw new Error('fixture');
  repository = mocks.repository = result.repository;
  mocks.scan.mockResolvedValue(snapshot);
});
describe('reconciliation coordination', () => {
  it('deduplicates simultaneous scans and commits one inherited child', async () => {
    const first = reconcileWorktrees(main.id);
    expect(reconcileWorktrees(main.id)).toBe(first);
    expect((await first).outcome).toBe('applied');
    expect(repository.getAll()).toHaveLength(2);
    expect(mocks.copy).toHaveBeenCalledTimes(1);
  });
  it('discards a scan after a user changes the project', async () => {
    let resolve!: (snapshot: WorktreeSnapshot) => void;
    mocks.scan.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const running = reconcileWorktrees(main.id);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    await repository.save({ ...main, cwd: '/changed', name: 'updated' });
    resolve(snapshot);
    expect((await running).outcome).toBe('stale');
    expect(repository.getAll()).toHaveLength(1);
    expect(repository.get(main.id)?.name).toBe('updated');
  });
  it('does not apply across a Create/Finish/Abandon lifecycle generation', async () => {
    let resolve!: (snapshot: WorktreeSnapshot) => void;
    mocks.scan.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const running = reconcileWorktrees(main.id);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    setWorktreeLifecycle(main.id, true);
    setWorktreeLifecycle(main.id, false);
    resolve(snapshot);
    expect((await running).outcome).toBe('stale');
    expect(repository.getAll()).toHaveLength(1);
  });
  it('skips a confirmed non-repository but preserves data on scan errors', async () => {
    mocks.scan.mockResolvedValueOnce(null);
    expect((await reconcileWorktrees(main.id)).outcome).toBe('skipped');
    mocks.scan.mockRejectedValueOnce(new Error('transport failed'));
    await expect(reconcileWorktrees(main.id)).rejects.toThrow('transport failed');
    expect(repository.getAll()).toHaveLength(1);
  });
  it('rolls back secrets if inheritance fails before publication', async () => {
    mocks.copy.mockImplementationOnce(() => { throw new Error('secret disk full'); });
    await expect(reconcileWorktrees(main.id)).rejects.toThrow('secret disk full');
    expect(repository.getAll()).toHaveLength(1);
    expect(mocks.remove).toHaveBeenCalledWith(`child-${id}`);
  });
  it('retries target discovery after an initial target failure', async () => {
    vi.resetModules();
    const fresh = await import('./reconcile');
    mocks.scan.mockResolvedValue(null);
    mocks.probeFacts.mockResolvedValueOnce({ ok: false, attempts: [{ detail: 'unreachable' }] });
    await expect(fresh.reconcileWorktrees(main.id)).rejects.toThrow('Cannot inspect target');
    expect((await fresh.reconcileWorktrees(main.id)).outcome).toBe('skipped');
  });

  it('keeps agent startup preference/session writes while applying its connect scan', async () => {
    let resolve!: (snapshot: WorktreeSnapshot) => void;
    mocks.scan.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const running = reconcileWorktrees(main.id);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    await repository.save({ ...main, agentSessionIds: { claude: 'new-session' }, name: 'latest name' });
    resolve(snapshot);
    expect((await running).outcome).toBe('applied');
    expect(repository.get(main.id)?.agentSessionIds).toEqual({ claude: 'new-session' });
    expect(repository.getAll()[1].name).toBe('latest name');
    expect(repository.getAll()[1].agentSessionIds).toEqual({});
  });

});
