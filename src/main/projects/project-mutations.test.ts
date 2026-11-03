import { describe, expect, it, vi } from 'vitest';
import { createMainProjectsRepository } from './projects-repository';
import { PROJECT_MUTATION as M } from '@shared/project-mutations';

function fixture() {
  const save = vi.fn(async (_projects: unknown) => ({ ok: true as const }));
  const result = createMainProjectsRepository({ load: () => ({ ok: true, value: [] }), save }, () => 'p', { cleanup: async () => {} });
  if (!result.ok) throw new Error('fixture');
  return { repo: result.repository, save };
}
async function ready() {
  const f = fixture();
  await f.repo.add({ name: 'original', cwd: '/repo', maxTabs: 5, connection: { type: 'local' } });
  await f.repo.save({ ...f.repo.get('p')!, agentViews: Object.fromEntries(['claude', 'copilot', 'codex'].map(provider => [provider, { provider, prefs: {} }])) });
  f.save.mockClear();
  return f;
}

function prefs(repo: Awaited<ReturnType<typeof ready>>['repo']) {
  return Object.fromEntries(Object.entries(repo.get('p')!.agentViews).filter(([, view]) => Object.keys(view.prefs).length).map(([id, view]) => [id, view.prefs]));
}

describe('queued project mutation intents', () => {
  it('merges disjoint editor fields and background reports from the latest canonical state', async () => {
    const { repo } = await ready();
    await Promise.all([
      repo.mutate('p', { kind: M.EDIT, edits: [{ field: 'name', before: 'original', value: 'edited' }] }),
      repo.mutate('p', { kind: M.AGENT_REPORT, sessionId: 'claude', report: { currentModel: 'model-b' } }),
      repo.mutate('p', { kind: M.EDIT, edits: [{ field: 'initScript', before: null, value: 'echo ready' }] }),
    ]);
    expect(repo.get('p')).toMatchObject({ name: 'edited', initScript: 'echo ready', agentViews: { claude: { prefs: { model: 'model-b' } } } });
  });

  it('preserves nested providers and sequential model/effort reports, including a return to the original value', async () => {
    const { repo } = await ready();
    await repo.mutate('p', { kind: M.AGENT_REPORT, sessionId: 'claude', report: { currentModel: 'a' } });
    await Promise.all([
      repo.mutate('p', { kind: M.AGENT_REPORT, sessionId: 'claude', report: { currentModel: 'b' } }),
      repo.mutate('p', { kind: M.AGENT_REPORT, sessionId: 'copilot', report: { confirmedPrefs: { effort: 'high' } } }),
      repo.mutate('p', { kind: M.AGENT_REPORT, sessionId: 'claude', report: { currentModel: 'a', currentEffort: 'low' } }),
    ]);
    expect(prefs(repo)).toEqual({ claude: { model: 'a', effort: 'low' }, copilot: { effort: 'high' } });
  });

  it('rejects a conflicting edit atomically and accepts already-satisfied values', async () => {
    const { repo, save } = await ready();
    await repo.mutate('p', { kind: M.EDIT, edits: [{ field: 'name', before: 'original', value: 'background' }] });
    save.mockClear();
    expect(await repo.mutate('p', { kind: M.EDIT, edits: [
      { field: 'name', before: 'original', value: 'draft' },
      { field: 'initScript', before: null, value: 'must not write' },
    ] })).toEqual({ ok: false, conflicts: ['name'] });
    expect(save).not.toHaveBeenCalled();
    expect(repo.get('p')).toMatchObject({ name: 'background', initScript: null });
    expect(await repo.mutate('p', { kind: M.EDIT, edits: [{ field: 'name', before: 'original', value: 'background' }] })).toEqual({ ok: true });
    expect(save).not.toHaveBeenCalled();
  });

  it('appends defaults to the latest list without duplicating an Agent provider', async () => {
    const { repo } = await ready();
    await Promise.all([
      repo.mutate('p', { kind: M.APPEND_DEFAULT_TAB, tab: { name: 'First' } }),
      repo.mutate('p', { kind: M.APPEND_DEFAULT_TAB, tab: { name: 'Claude', kind: 'agent', provider: 'claude', sessionId: 'claude' } }),
      repo.mutate('p', { kind: M.APPEND_DEFAULT_TAB, tab: { name: 'Duplicate', kind: 'agent', provider: 'claude', sessionId: 'claude' } }),
    ]);
    expect(repo.get('p')?.defaultTabs.map(tab => tab.name)).toEqual(['Terminal', 'First', 'Claude']);
  });

  it('clears only the expected saved preference and preserves newer selections', async () => {
    const { repo } = await ready();
    await repo.mutate('p', { kind: M.AGENT_REPORT, sessionId: 'claude', report: { currentModel: 'new', currentEffort: 'high' } });
    await repo.mutate('p', { kind: M.CLEAR_AGENT_PREF, sessionId: 'claude', key: 'model', savedValue: 'old' });
    expect(prefs(repo).claude.model).toBe('new');
    await repo.mutate('p', { kind: M.CLEAR_AGENT_PREF, sessionId: 'claude', key: 'model', savedValue: 'new' });
    expect(prefs(repo).claude).toEqual({ effort: 'high' });
  });

  it('does not publish on persistence failure and keeps the queue usable', async () => {
    const { repo, save } = await ready();
    save.mockResolvedValueOnce({ ok: false, error: { stage: 'write', message: 'disk full' } } as never);
    const before = repo.get('p')!.agentViews;
    await expect(repo.mutate('p', { kind: M.CREATE_AGENT_VIEW, provider: 'claude' })).rejects.toThrow('disk full');
    expect(repo.get('p')?.agentViews).toEqual(before);
    const created = await repo.mutate('p', { kind: M.CREATE_AGENT_VIEW, provider: 'copilot' });
    expect(created.ok && created.sessionId).toBeTruthy();
    expect(Object.keys(repo.get('p')!.agentViews)).toHaveLength(4);
    await expect(repo.mutate('gone', { kind: M.CREATE_AGENT_VIEW, provider: 'claude' })).rejects.toThrow('not found');
  });

  it('creates independent sessions even for the same provider and rejects unknown bindings', async () => {
    const { repo } = await ready();
    const created = await Promise.all([
      repo.mutate('p', { kind: M.CREATE_AGENT_VIEW, provider: 'claude' }),
      repo.mutate('p', { kind: M.CREATE_AGENT_VIEW, provider: 'claude' }),
    ]);
    expect(created[0]).not.toEqual(created[1]);
    expect(Object.keys(repo.get('p')!.agentViews)).toHaveLength(5);
    await expect(repo.mutate('p', { kind: M.AGENT_REPORT, sessionId: 'other', report: {} })).rejects.toThrow('Unknown Agent');
  });

  it('does not pin native defaults or persist an empty confirmed report', async () => {
    const { repo, save } = await ready();
    await repo.mutate('p', { kind: M.AGENT_REPORT, sessionId: 'codex', report: { currentModel: 'default', confirmedPrefs: {} } });
    expect(prefs(repo)).toEqual({});
    expect(save).not.toHaveBeenCalled();
    await repo.mutate('p', { kind: M.AGENT_REPORT, sessionId: 'codex', report: { confirmedPrefs: { nativeApproval: 'never' } } });
    expect(prefs(repo)).toEqual({ codex: { nativeApproval: 'never' } });
  });

  it('rejects unknown fields and duplicate edits without writing', async () => {
    const { repo, save } = await ready();
    await expect(repo.mutate('p', { kind: M.EDIT, edits: [{ field: 'agentPrefs', before: {}, value: {} }] } as never)).rejects.toThrow('Invalid');
    await expect(repo.mutate('p', { kind: M.EDIT, edits: [
      { field: 'name', before: 'original', value: 'one' }, { field: 'name', before: 'original', value: 'two' },
    ] })).rejects.toThrow('duplicate');
    expect(save).not.toHaveBeenCalled();
  });

  it('preserves worktree metadata and rejects editing a missing checkout or child note binding', async () => {
    const { repo } = await ready();
    await repo.save({ ...repo.get('p')!, parentProjectId: 'parent', worktreeBranch: 'feature',
      worktreeState: { availability: 'valid', identity: null }, featureNoteDir: 'notes' });
    await repo.mutate('p', { kind: M.EDIT, edits: [{ field: 'name', before: 'original', value: 'edited' }] });
    expect(repo.get('p')).toMatchObject({ worktreeBranch: 'feature', worktreeState: { availability: 'valid' } });
    await expect(repo.mutate('p', { kind: M.EDIT, edits: [{ field: 'featureNoteDir', before: 'notes', value: 'other' }] })).rejects.toThrow('read-only');
    await repo.reconcileWorktrees(repo.getAll(), [{ ...repo.get('p')!, worktreeState: { availability: 'missing', identity: null } }], []);
    await expect(repo.mutate('p', { kind: M.EDIT, edits: [] })).rejects.toThrow('unavailable');
  });
});
