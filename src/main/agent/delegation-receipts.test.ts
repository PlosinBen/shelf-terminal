import { describe, it, expect, vi } from 'vitest';
import { createDelegationReceipts } from './delegation-receipts';
import { DELEGATION as D } from '@shared/agent-delegation';

describe('delegation queue receipts', () => {
  it('confirms queue acceptance without waiting for execution completion and filters only internal IDs', async () => {
    const receipts = createDelegationReceipts(); const accepted = vi.fn();
    const entry = receipts.register('tab', 'internal', accepted); entry.written();
    expect(receipts.snapshot('tab', [{ clientMsgId: 'internal', state: 'queued' }, { clientMsgId: 'ui', state: 'running' }]))
      .toEqual([{ clientMsgId: 'ui', state: 'running' }]);
    await expect(entry.promise).resolves.toEqual({ state: D.DELIVERY.RECEIVED });
    receipts.snapshot('tab', [{ clientMsgId: 'internal', state: 'running' }]);
    expect(accepted).toHaveBeenCalledTimes(1); entry.finish();
  });
  it('distinguishes failure before write from uncertain delivery and reconciles a late receipt', async () => {
    vi.useFakeTimers();
    try {
      const receipts = createDelegationReceipts(10); const accepted = vi.fn();
      const failed = receipts.register('tab', 'failed', accepted); failed.finish('auth required');
      await expect(failed.promise).resolves.toEqual({ state: D.DELIVERY.FAILED, error: 'auth required' });
      const late = receipts.register('tab', 'late', accepted); late.written();
      await vi.advanceTimersByTimeAsync(11);
      expect((await late.promise).state).toBe(D.DELIVERY.UNKNOWN);
      expect(receipts.snapshot('other-tab', [{ clientMsgId: 'late', state: 'running' }]))
        .toEqual([{ clientMsgId: 'late', state: 'running' }]);
      expect(accepted).not.toHaveBeenCalled();
      receipts.snapshot('tab', [{ clientMsgId: 'late', state: 'running' }]);
      expect(accepted).toHaveBeenCalledTimes(1); late.finish();
    } finally { vi.useRealTimers(); }
  });
});
