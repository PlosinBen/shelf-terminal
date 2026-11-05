import { describe, it, expect, vi } from 'vitest';
import { createSendQueue } from './send-queue';
import { createSessionConfigControl } from './session-config-control';
import { CONFIG_CONTROL as C, type ConfigControlUpdate } from '@shared/agent-config-control';
import type { ServerBackend } from './providers/types';

function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(defer: boolean) {
  const work = gate(); const setting = gate(); const order: string[] = []; const updates: ConfigControlUpdate[] = [];
  const queue = createSendQueue({ handle: async (m: { clientMsgId: string }) => { order.push(m.clientMsgId); if (m.clientMsgId === 'a') await work.promise; }, emitSnapshot: vi.fn(), terminateExecution: vi.fn(), onHandleError: vi.fn() });
  const configure = vi.fn(async () => { order.push('configure'); await setting.promise; });
  const backend = { configRequiresIdle: () => defer, configure } as unknown as ServerBackend;
  const control = createSessionConfigControl(queue, update => updates.push(update));
  return { work, setting, order, updates, queue, control, backend, configure };
}
describe('independent session configuration', () => {
  it('does not copy inbound wire envelopes into control results', async () => {
    const s = setup(false); s.setting.resolve();
    await s.control({ type: C.REQUEST, executionId: 'must-not-leak', requestId: 'r', key: 'model', value: 'x' }, s.backend);
    expect(s.updates.at(-1)).toEqual({ requestId: 'r', key: 'model', value: 'x', state: C.STATE.CONFIRMED });
  });
  it.each([false, true])('applies live/deferred=%s without queue projection and before the next message', async defer => {
    const s = setup(defer);
    s.queue.enqueue({ clientMsgId: 'a' }); s.queue.enqueue({ clientMsgId: 'b' }); await tick();
    const pending = s.control({ requestId: 'r', key: 'effort', value: 'high' }, s.backend); await tick();
    expect(s.order).toEqual(defer ? ['a'] : ['a', 'configure']);
    expect(s.queue.snapshot().map(x => x.clientMsgId)).toEqual(['a', 'b']);
    s.work.resolve(); await tick(); expect(s.order).toEqual(['a', 'configure']);
    s.setting.resolve(); await pending; await tick(); expect(s.order).toEqual(['a', 'configure', 'b']);
    expect(s.updates.map(x => x.state)).toEqual([C.STATE.DEFERRED, C.STATE.APPLYING, C.STATE.CONFIRMED]);
  });
  it('rejects another key while pending and settles same-value/no-op requests', async () => {
    const s = setup(false);
    const first = s.control({ requestId: 'a', key: 'model', value: 'x' }, s.backend); await tick();
    await s.control({ requestId: 'b', key: 'effort', value: 'high' }, s.backend);
    expect(s.updates.at(-1)?.state).toBe(C.STATE.REJECTED); expect(s.configure).toHaveBeenCalledTimes(1);
    s.setting.resolve(); await first;
    await s.control({ requestId: 'c', key: 'model', value: 'x' }, s.backend);
    expect(s.updates.at(-1)?.state).toBe(C.STATE.CONFIRMED);
  });
  it('does not count safe-boundary waiting as apply timeout; uncertain apply retains queued input', async () => {
    vi.useFakeTimers();
    try {
      const s = setup(true); s.queue.enqueue({ clientMsgId: 'a' }); await tick();
      const pending = s.control({ requestId: 'r', key: 'effort', value: 'high' }, s.backend);
      await vi.advanceTimersByTimeAsync(C.APPLY_TIMEOUT_MS * 2);
      expect(s.updates.at(-1)?.state).toBe(C.STATE.DEFERRED);
      s.queue.enqueue({ clientMsgId: 'b' }); s.work.resolve(); await tick();
      await vi.advanceTimersByTimeAsync(C.APPLY_TIMEOUT_MS); await pending;
      expect(s.updates.at(-1)?.state).toBe(C.STATE.UNCERTAIN);
      s.setting.resolve(); await tick();
      expect(s.order).toEqual(['a', 'configure']);
      expect(s.queue.snapshot()).toEqual([{ clientMsgId: 'b', state: 'queued' }]);
    } finally { vi.useRealTimers(); }
  });
});
