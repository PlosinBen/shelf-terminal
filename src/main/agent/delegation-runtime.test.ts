import { describe, it, expect, vi } from 'vitest';
import { configureDelegationRuntime, selectDelegationTarget, resolveDelegationTarget, cancelDelegationPickers } from './delegation-runtime';
import { createDelegationService } from './delegation';
import { DELEGATION as D, type DelegationView, type DelegationPicker } from '@shared/agent-delegation';

describe('delegation target picker round-trip', () => {
  function setup(show = true) {
    const main: DelegationView = { projectId: 'main', agentViewId: 'view-main', tabId: 'tab-main', displayName: 'main', projectName: 'main', cwd: '/', provider: 'claude', worktree: false, available: true };
    const spike = { ...main, projectId: 'spike', agentViewId: 'view-spike', tabId: 'tab-spike', worktree: true };
    const service = createDelegationService({ views: () => [main, spike], changed: vi.fn(), mintId: () => 'delegation', deliver: async () => ({ state: D.DELIVERY.RECEIVED }) });
    const picker = vi.fn((_request: DelegationPicker | { requestId: string }) => show);
    configureDelegationRuntime({ service, caller: () => main, picker });
    return { main, spike, service, picker };
  }
  it('waits for explicit selection, then grants only that caller-target pair', async () => {
    const { picker, main, spike, service } = setup();
    const result = selectDelegationTarget({});
    const request = picker.mock.calls[0][0] as DelegationPicker;
    expect(request.candidates.map(c => c.view.agentViewId)).toEqual([spike.agentViewId]);
    await expect(service.start(main, spike, 'premature')).rejects.toThrow('Select');
    resolveDelegationTarget(request.requestId, spike);
    await expect(result).resolves.toMatchObject({ cancelled: false, target: { agentViewId: spike.agentViewId } });
    expect(JSON.stringify(await result)).not.toContain('tabId');
    await expect(service.start(main, spike, 'A')).resolves.toHaveProperty('delegationId');
  });
  it('cancels on caller closure or absent UI; never leaves an authorization', async () => {
    const { picker, main, spike, service } = setup();
    const result = selectDelegationTarget({});
    cancelDelegationPickers([main.tabId]);
    await expect(result).resolves.toEqual({ cancelled: true });
    await expect(service.start(main, spike, 'A')).rejects.toThrow('Select');
    expect(picker).toHaveBeenCalledTimes(2);
    setup(false); await expect(selectDelegationTarget({})).resolves.toEqual({ cancelled: true });
  });
  it('expires pending selection without establishing a grant', async () => {
    vi.useFakeTimers();
    try {
      setup(); const result = selectDelegationTarget({});
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await expect(result).resolves.toEqual({ cancelled: true });
    } finally { vi.useRealTimers(); }
  });
});
