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
  f.save.mockClear();
  return f;
}

describe('queued project mutation intents', () => {
  it('merges disjoint editor fields and background reports from the latest canonical state', async () => {
    const { repo } = await ready();
    await Promise.all([
      repo.mutate('p', { kind: M.EDIT, edits: [{ field: 'name', before: 'original', value: 'edited' }] }),
      repo.mutate('p', { kind: M.AGENT_REPORT, provider: 'claude', report: { currentModel: 'model-b' } }),
      repo.mutate('p', { kind: M.EDIT, edits: [{ field: 'initScript', before: null, value: 'echo ready' }] }),
    ]);
    expect(repo.get('p')).toMatchObject({ name: 'edited', initScript: 'echo ready', agentPrefs: { claude: { model: 'model-b' } } });
  });

  it('preserves nested providers and sequential model/effort reports, including a return to the original value', async () => {
    const { repo } = await ready();
    await repo.mutate('p', { kind: M.AGENT_REPORT, provider: 'claude', report: { currentModel: 'a' } });
    await Promise.all([
      repo.mutate('p', { kind: M.AGENT_REPORT, provider: 'claude', report: { currentModel: 'b' } }),
      repo.mutate('p', { kind: M.AGENT_REPORT, provider: 'copilot', report: { confirmedPrefs: { effort: 'high' } } }),
      repo.mutate('p', { kind: M.AGENT_REPORT, provider: 'claude', report: { currentModel: 'a', currentEffort: 'low' } }),
    ]);
    expect(repo.get('p')?.agentPrefs).toEqual({ claude: { model: 'a', effort: 'low' }, copilot: { effort: 'high' } });
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
      repo.mutate('p', { kind: M.APPEND_DEFAULT_TAB, tab: { name: 'Claude', kind: 'agent', provider: 'claude' } }),
      repo.mutate('p', { kind: M.APPEND_DEFAULT_TAB, tab: { name: 'Duplicate', kind: 'agent', provider: 'claude' } }),
    ]);
    expect(repo.get('p')?.defaultTabs.map(tab => tab.name)).toEqual(['Terminal', 'First', 'Claude']);
  });

  it('clears only the expected saved preference and preserves newer selections', async () => {
    const { repo } = await ready();
    await repo.mutate('p', { kind: M.AGENT_REPORT, provider: 'claude', report: { currentModel: 'new', currentEffort: 'high' } });
    await repo.mutate('p', { kind: M.CLEAR_AGENT_PREF, provider: 'claude', key: 'model', savedValue: 'old' });
    expect(repo.get('p')?.agentPrefs.claude.model).toBe('new');
    await repo.mutate('p', { kind: M.CLEAR_AGENT_PREF, provider: 'claude', key: 'model', savedValue: 'new' });
    expect(repo.get('p')?.agentPrefs.claude).toEqual({ effort: 'high' });
  });

  it('does not publish on persistence failure and keeps the queue usable', async () => {
    const { repo, save } = await ready();
    save.mockResolvedValueOnce({ ok: false, error: { stage: 'write', message: 'disk full' } } as never);
    await expect(repo.mutate('p', { kind: M.AGENT_SESSION, provider: 'claude', sessionId: 's1' })).rejects.toThrow('disk full');
    expect(repo.get('p')?.agentSessionIds).toEqual({});
    await repo.mutate('p', { kind: M.AGENT_SESSION, provider: 'copilot', sessionId: 's2' });
    expect(repo.get('p')?.agentSessionIds).toEqual({ copilot: 's2' });
    await expect(repo.mutate('gone', { kind: M.AGENT_SESSION, provider: 'claude', sessionId: 's3' })).rejects.toThrow('not found');
  });

  it('keeps sessions for distinct providers and fails loudly on an inconsistent binding', async () => {
    const { repo } = await ready();
    await Promise.all([
      repo.mutate('p', { kind: M.AGENT_SESSION, provider: 'claude', sessionId: 'c' }),
      repo.mutate('p', { kind: M.AGENT_SESSION, provider: 'copilot', sessionId: 'g' }),
    ]);
    expect(repo.get('p')?.agentSessionIds).toEqual({ claude: 'c', copilot: 'g' });
    await expect(repo.mutate('p', { kind: M.AGENT_SESSION, provider: 'claude', sessionId: 'other' })).rejects.toThrow('already assigned');
  });

  it('does not pin native defaults or persist an empty confirmed report', async () => {
    const { repo, save } = await ready();
    await repo.mutate('p', { kind: M.AGENT_REPORT, provider: 'codex', report: { currentModel: 'default', confirmedPrefs: {} } });
    expect(repo.get('p')?.agentPrefs).toEqual({});
    expect(save).not.toHaveBeenCalled();
    await repo.mutate('p', { kind: M.AGENT_REPORT, provider: 'codex', report: { confirmedPrefs: { nativeApproval: 'never' } } });
    expect(repo.get('p')?.agentPrefs).toEqual({ codex: { nativeApproval: 'never' } });
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
