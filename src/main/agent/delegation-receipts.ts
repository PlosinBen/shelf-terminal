import { DELEGATION as D, type DeliveryReceipt } from '@shared/agent-delegation';
import type { AgentQueueItem } from '@shared/types';

/** D1 reuses queue snapshots; no new wire ACK or provider completion semantics. */
export function createDelegationReceipts(timeoutMs = 10_000) {
  interface Pending {
    tabId: string; written: boolean; received: boolean;
    resolve: (value: DeliveryReceipt) => void; accepted: () => void; timer: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<string, Pending>();
  return {
    register(tabId: string, id: string, accepted: () => void) {
      if (pending.has(id)) throw new Error(`Duplicate delegation message ${id}`);
      let resolve!: (value: DeliveryReceipt) => void;
      const promise = new Promise<DeliveryReceipt>(r => { resolve = r; });
      const timer = setTimeout(() => resolve({ state: D.DELIVERY.UNKNOWN, error: 'Queue receipt timed out; do not automatically resend' }), timeoutMs);
      timer.unref?.();
      pending.set(id, { tabId, written: false, received: false, resolve, accepted, timer });
      return {
        promise,
        written() { const p = pending.get(id); if (p) p.written = true; },
        finish(error = 'Execution ended without queue receipt') {
          const p = pending.get(id); if (!p) return;
          clearTimeout(p.timer); pending.delete(id);
          if (!p.received) p.resolve({ state: p.written ? D.DELIVERY.UNKNOWN : D.DELIVERY.FAILED, error });
        },
      };
    },
    snapshot(tabId: string, items: AgentQueueItem[]) {
      for (const item of items) {
        const p = pending.get(item.clientMsgId);
        if (!p || p.tabId !== tabId || p.received) continue;
        p.received = true; clearTimeout(p.timer); p.accepted(); p.resolve({ state: D.DELIVERY.RECEIVED });
      }
      // Internal callers mirror history, not optimistic chips. Never send their
      // IDs into renderer reconciliation as running-without-content anomalies.
      return items.filter(item => pending.get(item.clientMsgId)?.tabId !== tabId);
    },
  };
}
