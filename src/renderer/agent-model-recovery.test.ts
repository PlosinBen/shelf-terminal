import { describe, it, expect, vi } from 'vitest';
import { createPrefRecovery } from './agent-model-recovery';
import { AgentInitRecoveryKind } from '@shared/agent-init-recovery';
import { ProjectMutationRefreshError } from './project-mutation-coordinator';
import { PROJECT_MUTATION, type ProjectMutation } from '@shared/project-mutations';

function fixture() {
  let project: any = { id: 'p', cwd: '/repo', connection: { type: 'local' }, agentViews: { session: { provider: 'copilot', prefs: { model: 'retired', effort: 'high' } }, other: { provider: 'claude', prefs: { model: 'keep' } } }, tabs: [{ id: 't' }] };
  let tab: any = { sessionId: 'session', provider: 'copilot', initStatus: 'failed', initRecovery: { kind: AgentInitRecoveryKind.CLEAR_SAVED_MODEL, model: 'retired' } };
  const deps = {
    project: () => project,
    tab: () => tab,
    save: vi.fn(async (_id: string, mutation: ProjectMutation) => {
      if (mutation.kind !== PROJECT_MUTATION.CLEAR_AGENT_PREF) throw new Error('unexpected fixture mutation');
      if (project.agentViews[mutation.sessionId].prefs?.[mutation.key] === mutation.savedValue) {
        const prefs = { ...project.agentViews[mutation.sessionId].prefs };
        delete prefs[mutation.key];
        project = { ...project, agentViews: { ...project.agentViews, [mutation.sessionId]: { ...project.agentViews[mutation.sessionId], prefs } } };
      }
      return { ok: true as const };
    }),
    refresh: vi.fn(async () => {}),
    status: vi.fn((_id: string, state: string) => { if (tab) tab = { ...tab, initStatus: state }; }),
    restart: vi.fn(),
  };
  return { deps, run: createPrefRecovery(deps), project: () => project, remove: () => { tab = undefined; } };
}

describe('model recovery transaction', () => {
  it('persists only model deletion before restarting the same session', async () => {
    const f = fixture();
    await f.run('t');
    expect(f.project().agentViews).toEqual({ session: { provider: 'copilot', prefs: { effort: 'high' } }, other: { provider: 'claude', prefs: { model: 'keep' } } });
    expect(f.deps.restart).toHaveBeenCalledWith('t', expect.objectContaining({ sessionId: 'session' }), f.project());
  });
  it('does not initialize after a save failure', async () => {
    const f = fixture();
    f.deps.save.mockRejectedValue(new Error('disk full'));
    await f.run('t');
    expect(f.deps.restart).not.toHaveBeenCalled();
    expect(f.project().agentViews.session.prefs.model).toBe('retired');
    expect(f.deps.status).toHaveBeenLastCalledWith('t', 'failed', expect.stringContaining('disk full'), expect.anything());
  });
  it('refreshes committed changes without rolling back or saving twice', async () => {
    const f = fixture();
    const save = f.deps.save.getMockImplementation()!;
    f.deps.save.mockImplementation(async (...args) => { await save(...args); throw new ProjectMutationRefreshError('save', undefined, new Error('refresh')); });
    await f.run('t');
    expect(f.deps.refresh).toHaveBeenCalledOnce();
    expect(f.deps.save).toHaveBeenCalledOnce();
    expect(f.deps.restart).toHaveBeenCalledOnce();
  });
  it('deduplicates clicks and does not resurrect a removed tab', async () => {
    const f = fixture();
    let finish!: () => void;
    f.deps.save.mockImplementation(() => new Promise<{ ok: true }>(resolve => { finish = () => resolve({ ok: true }); }));
    const pending = f.run('t');
    await f.run('t');
    expect(f.deps.save).toHaveBeenCalledOnce();
    f.remove(); finish(); await pending;
    expect(f.deps.restart).not.toHaveBeenCalled();
  });
  it('ordinary retry refreshes the saved intent and never deletes it', async () => {
    const f = fixture();
    await f.run('t', false);
    expect(f.deps.refresh).toHaveBeenCalledOnce();
    expect(f.deps.save).not.toHaveBeenCalled();
    expect(f.deps.restart).toHaveBeenCalledOnce();
    expect(f.project().agentViews.session.prefs.model).toBe('retired');
  });

  it('ordinary retry cannot initialize from stale prefs after a refresh failure', async () => {
    const f = fixture();
    f.deps.refresh.mockRejectedValue(new Error('cannot refresh'));
    await f.run('t', false);
    expect(f.deps.restart).not.toHaveBeenCalled();
    expect(f.deps.status).toHaveBeenLastCalledWith('t', 'failed', expect.stringContaining('cannot refresh'), expect.anything());
  });

  it('does not delete a newer model selection', async () => {
    const f = fixture();
    f.project().agentViews.session.prefs.model = 'new-model';
    await f.run('t');
    expect(f.deps.save).toHaveBeenCalledWith('p', {
      kind: PROJECT_MUTATION.CLEAR_AGENT_PREF, sessionId: 'session', key: 'model', savedValue: 'retired',
    });
    expect(f.project().agentViews.session.prefs.model).toBe('new-model');
    expect(f.deps.restart).toHaveBeenCalledOnce();
  });
});

it.each(['model', 'effort', 'permissionMode', 'nativeMode', 'nativePermission', 'nativeApproval'])('clears only saved %s through the existing restart transaction', async key => {
  const f = fixture();
  f.project().agentViews.session.prefs[key] = 'retired';
  f.deps.tab().initRecovery = { kind: 'clear_saved_pref', key, savedValue: 'retired', label: key };
  const expected = { ...f.project().agentViews.session.prefs };
  delete expected[key];
  await f.run('t');
  expect(f.project().agentViews.session.prefs).toEqual(expected);
  expect(f.project().agentViews.other.prefs).toEqual({ model: 'keep' });
  expect(f.deps.restart).toHaveBeenCalledWith('t', expect.objectContaining({ sessionId: 'session' }), f.project());
});
