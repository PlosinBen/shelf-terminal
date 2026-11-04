import { describe, it, expect, vi } from 'vitest';
import { createDelegationService, type DelegationDeps } from './delegation';
import { DELEGATION as D, type DelegationView } from '@shared/agent-delegation';

const view = (id: string, worktree = true): DelegationView => ({
  projectId: `project-${id}`, agentViewId: id, tabId: `tab-${id}`, displayName: id,
  projectName: id, cwd: '/test', provider: 'claude', worktree, available: true,
});
function setup() {
  const main = view('main', false), spike = view('spike'), other = view('other');
  let views = [main, spike, other];
  let seq = 0;
  const deliver = vi.fn<DelegationDeps['deliver']>(async (_target, _input, received) => { received(); return { state: D.DELIVERY.RECEIVED }; });
  const service = createDelegationService({ views: () => views, deliver, changed: vi.fn(), mintId: () => `${++seq}` });
  const start = async () => { service.select(main, spike); return (await service.start(main, spike, 'verify A')).delegationId; };
  return { service, main, spike, other, deliver, start, setViews: (next: DelegationView[]) => { views = next; } };
}
describe('Shelf delegation', () => {
  it('requires picker authorization, worktree target and exclusive recipient ownership', async () => {
    const { service, main, spike, other, start } = setup();
    await expect(service.start(main, spike, 'A')).rejects.toThrow('Select');
    expect(() => service.select(spike, main)).toThrow('worktree');
    expect(() => service.select(spike, spike)).toThrow('same View');
    await start();
    expect(() => service.select(other, spike)).toThrow(D.ERROR.OCCUPIED);
  });
  it('keeps one result and relation across extraction and subsequent phases; state never leaks result', async () => {
    const { service, main, spike, deliver, start } = setup(); const id = await start();
    service.progress(spike, id, 'progress secret'); service.submit(spike, id, 'result secret');
    expect(() => service.submit(spike, id, 'overwrite')).toThrow(D.ERROR.RESULT_EXISTS);
    expect(JSON.stringify(service.status(main, id))).not.toMatch(/secret/);
    expect(JSON.stringify(service.snapshots())).not.toContain('result secret');
    await service.extract(id);
    expect(service.snapshots()[0].resultState).toBeNull();
    await service.send(main, id, 'verify B');
    service.submit(spike, id, 'B result');
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(service.snapshots()).toHaveLength(1);
  });
  it('rejects main work during intervention without blocking progress or results', async () => {
    const { service, main, spike, start, deliver } = setup(); const id = await start();
    expect(() => service.assertUserInput(spike.tabId)).toThrow('Intervene');
    service.intervene(id, true); service.assertUserInput(spike.tabId);
    await expect(service.send(main, id, 'B')).rejects.toThrow(D.ERROR.INTERVENING);
    service.progress(spike, id, 'debugging'); service.submit(spike, id, 'A');
    service.intervene(id, false); await service.send(main, id, 'B');
    expect(deliver).toHaveBeenCalledTimes(2);
  });
  it('checks participant roles and refuses stale delegation IDs after stop', async () => {
    const { service, main, spike, other, start } = setup(); const id = await start();
    expect(() => service.submit(main, id, 'fake')).toThrow(D.ERROR.FORBIDDEN);
    expect(() => service.status(other, id)).toThrow(D.ERROR.FORBIDDEN);
    await expect(service.send(other, id, 'fake')).rejects.toThrow(D.ERROR.FORBIDDEN);
    service.stop(id); expect(service.snapshots()).toEqual([]);
    await expect(service.start(main, spike, 'again')).rejects.toThrow('Select');
    const next = await start(); expect(next).not.toBe(id);
    expect(() => service.submit(spike, id, 'late')).toThrow(D.ERROR.MISSING);
  });
  it('requires discard confirmation for stop and atomic multi-View closure', async () => {
    const { service, main, spike, start } = setup(); const id = await start(); service.submit(spike, id, 'A');
    expect(() => service.stop(id)).toThrow(D.ERROR.DISCARD);
    expect(service.prepareClose([main.tabId])).toBe(false);
    expect(service.snapshots()).toHaveLength(1);
    expect(service.prepareClose([spike.tabId], true)).toBe(true);
    expect(service.snapshots()).toEqual([]);
  });
  it('retains failed/unknown extractions and reconciles late receipt without automatic resend', async () => {
    const { service, spike, start, deliver } = setup(); const id = await start(); service.submit(spike, id, 'A');
    deliver.mockImplementationOnce(async () => ({ state: D.DELIVERY.FAILED, error: 'offline' }));
    await service.extract(id); expect(service.snapshots()[0].resultState).toBe(D.RESULT.READY);
    let late!: () => void;
    deliver.mockImplementationOnce(async (_target, _input, received) => { late = received; return { state: D.DELIVERY.UNKNOWN }; });
    await service.extract(id); expect(service.snapshots()[0].resultState).toBe(D.RESULT.UNKNOWN);
    await expect(service.extract(id)).rejects.toThrow('No result');
    late(); expect(service.snapshots()[0].resultState).toBeNull();
  });
  it('supports multiple delegates but keeps worker results and authorizations separate', async () => {
    const { service, main, spike, other, start } = setup(); const first = await start();
    service.select(main, other); const second = (await service.start(main, other, 'another experiment')).delegationId;
    expect(service.status(main)).toHaveLength(2);
    expect(service.status(spike)).toHaveLength(1);
    expect(() => service.submit(spike, second, 'wrong target')).toThrow(D.ERROR.FORBIDDEN);
    service.submit(spike, first, 'A'); service.submit(other, second, 'B');
    service.stop(first, true);
    expect(service.status(main).map(entry => entry.delegationId)).toEqual([second]);
  });
  it('does not enter intervention if the recipient View is already missing', async () => {
    const { service, main, start, setViews } = setup(); const id = await start();
    setViews([main]);
    expect(() => service.intervene(id, true)).toThrow('no longer open');
    expect(service.snapshots()[0].intervening).toBe(false);
  });
});
