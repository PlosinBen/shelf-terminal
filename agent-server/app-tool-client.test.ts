import { describe, expect, it, vi } from 'vitest';
import { callMain, initAppToolClient, resolveAppToolResult } from './app-tool-client';

describe('bounded, incarnation-specific internal bridge requests', () => {
  it('does not resolve a new exec bootstrap with a late old-exec reply', async () => {
    const send = vi.fn();
    initAppToolClient(send);
    const pending = callMain('internal.test', {}, { requestId: 'new-exec', timeoutMs: 1000 });
    const result = vi.fn();
    void pending.then(result);
    resolveAppToolResult('old-exec', { ok: true, data: 'old' });
    await Promise.resolve();
    expect(result).not.toHaveBeenCalled();
    resolveAppToolResult('new-exec', { ok: true, data: 'new' });
    await expect(pending).resolves.toEqual({ ok: true, data: 'new' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'new-exec' }));
  });

  it('removes a timed-out waiter so a late reply cannot satisfy another request', async () => {
    vi.useFakeTimers();
    try {
      initAppToolClient(() => {});
      const pending = callMain('internal.test', {}, { requestId: 'timed-out', timeoutMs: 25 });
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toMatchObject({ ok: false, error: expect.stringContaining('timed out') });
      resolveAppToolResult('timed-out', { ok: true, data: 'late' });
      const fresh = callMain('internal.test', {}, { requestId: 'fresh' });
      resolveAppToolResult('fresh', { ok: true });
      await expect(fresh).resolves.toEqual({ ok: true });
    } finally { vi.useRealTimers(); }
  });
});
