import { afterEach, describe, expect, it, vi } from 'vitest';
import { DELEGATION as D, type DelegationSnapshot } from '@shared/agent-delegation';
import { bindDelegationEvents, prepareDelegationClose } from './delegation-events';
import { getDelegations, setDelegations, setDelegationError, setDelegationBusy } from './delegationStore';
import { emitAgent, __resetBusForTests } from './events';

vi.mock('./store', () => ({ getProjectById: vi.fn(), getProjectIndexById: vi.fn(), setActiveProjectById: vi.fn(), setActiveTab: vi.fn() }));
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; __resetBusForTests(); setDelegations([]); setDelegationError(null); setDelegationBusy('d', false); vi.restoreAllMocks(); });
function setup() {
  const api = {
    current: vi.fn(async () => [] as DelegationSnapshot[]), action: vi.fn(async () => ({ ok: true })),
    resolve: vi.fn(), rename: vi.fn(), prepareClose: vi.fn(async () => true),
    onUpdate: vi.fn((_callback: (value: DelegationSnapshot[]) => void) => vi.fn()),
    onPicker: vi.fn(() => vi.fn()), onPickerClose: vi.fn(() => vi.fn()),
  };
  const confirm = vi.fn(async () => false);
  (globalThis as any).window = { shelfApi: { delegation: api, dialog: { confirm } } };
  return { api, confirm };
}
describe('delegation central renderer handler', () => {
  it('only projects result availability; never automatically sends or collects a result', async () => {
    const { api } = setup(); cleanup = bindDelegationEvents();
    api.onUpdate.mock.calls[0][0]([{ id: 'd', resultState: D.RESULT.READY } as DelegationSnapshot]);
    await Promise.resolve();
    expect(getDelegations().entries[0].id).toBe('d');
    expect(api.action).not.toHaveBeenCalled();
  });
  it('does not overwrite a fresh event with a stale hydration response', async () => {
    const { api } = setup(); let resolve!: (value: DelegationSnapshot[]) => void;
    api.current.mockImplementation(() => new Promise(r => { resolve = r; })); cleanup = bindDelegationEvents();
    api.onUpdate.mock.calls[0][0]([{ id: 'fresh' } as DelegationSnapshot]);
    resolve([]); await Promise.resolve();
    expect(getDelegations().entries.map(e => e.id)).toEqual(['fresh']);
  });
  it('keeps closure cancelled until explicit discard confirmation and fails closed on IPC failure', async () => {
    const { api, confirm } = setup();
    api.prepareClose.mockResolvedValue(false);
    expect(await prepareDelegationClose(['tab'])).toBe(false);
    expect(api.prepareClose).toHaveBeenCalledTimes(1);
    confirm.mockResolvedValue(true); api.prepareClose.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await prepareDelegationClose(['tab'])).toBe(true);
    expect(api.prepareClose).toHaveBeenLastCalledWith(['tab'], true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.prepareClose.mockRejectedValue(new Error('transport failed'));
    expect(await prepareDelegationClose(['tab'])).toBe(false);
    expect(getDelegations().error).toContain('transport failed');
  });
  it('does not submit a destructive stop when the user cancels the uncollected-result warning', async () => {
    const { api, confirm } = setup(); cleanup = bindDelegationEvents();
    api.onUpdate.mock.calls[0][0]([{ id: 'd', resultState: D.RESULT.READY } as DelegationSnapshot]);
    emitAgent(D.EVENT.ACTION, { id: 'd', action: D.ACTION.STOP });
    await vi.waitFor(() => expect(getDelegations().busy).not.toContain('d'));
    expect(confirm).toHaveBeenCalledOnce(); expect(api.action).not.toHaveBeenCalled();
  });
});
