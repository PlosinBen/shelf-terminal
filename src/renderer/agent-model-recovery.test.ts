import { describe, it, expect, vi } from 'vitest';
import { createModelRecovery } from './agent-model-recovery';
import { AgentInitRecoveryKind } from '@shared/agent-init-recovery';
import { ProjectMutationRefreshError } from './project-mutation-coordinator';

function fixture() {
  let project: any = { id: 'p', cwd: '/repo', connection: { type: 'local' }, agentPrefs: { copilot: { model: 'retired', effort: 'high' }, claude: { model: 'keep' } }, tabs: [{ id: 't' }] };
  let tab: any = { sessionId: 'session', provider: 'copilot', initStatus: 'failed', initRecovery: { kind: AgentInitRecoveryKind.CLEAR_SAVED_MODEL, model: 'retired' } };
  const deps = {
    project: () => project,
    tab: () => tab,
    save: vi.fn(async (_id: string, changes: any) => { project = { ...project, ...changes }; }),
    refresh: vi.fn(async () => {}),
    status: vi.fn((_id: string, state: string) => { if (tab) tab = { ...tab, initStatus: state }; }),
    restart: vi.fn(),
  };
  return { deps, run: createModelRecovery(deps), project: () => project, remove: () => { tab = undefined; } };
}

describe('model recovery transaction', () => {
  it('persists only model deletion before restarting the same session', async () => {
    const f = fixture();
    await f.run('t');
    expect(f.project().agentPrefs).toEqual({ copilot: { effort: 'high' }, claude: { model: 'keep' } });
    expect(f.deps.restart).toHaveBeenCalledWith('t', expect.objectContaining({ sessionId: 'session' }), f.project());
  });
  it('does not initialize after a save failure', async () => {
    const f = fixture();
    f.deps.save.mockRejectedValue(new Error('disk full'));
    await f.run('t');
    expect(f.deps.restart).not.toHaveBeenCalled();
    expect(f.project().agentPrefs.copilot.model).toBe('retired');
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
    f.deps.save.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
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
    expect(f.project().agentPrefs.copilot.model).toBe('retired');
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
    f.project().agentPrefs.copilot.model = 'new-model';
    await f.run('t');
    expect(f.deps.save).not.toHaveBeenCalled();
    expect(f.deps.restart).toHaveBeenCalledOnce();
  });
});
