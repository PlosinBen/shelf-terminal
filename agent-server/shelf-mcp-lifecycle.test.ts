import { expect, it, vi } from 'vitest';
import { createShelfMcpLifecycle, ShelfMcpStartupError } from './shelf-mcp-lifecycle';
import { SHELF_MCP_FAILURE, SHELF_MCP_STATE } from '@shared/shelf-mcp';

it('starts lazily once and reports startup availability, not provider health', async () => {
  const endpoint = { url: 'http://127.0.0.1:1234/mcp' };
  const start = vi.fn(async () => endpoint);
  const report = vi.fn();
  const lifecycle = createShelfMcpLifecycle({ start, report, log: vi.fn() });
  expect(start).not.toHaveBeenCalled();
  const results = await Promise.all([lifecycle.getEndpoint(), lifecycle.getEndpoint()]);
  expect(results).toEqual([endpoint, endpoint]);
  expect(start).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledExactlyOnceWith({ state: SHELF_MCP_STATE.AVAILABLE });
});

it.each(Object.values(SHELF_MCP_FAILURE))('caches %s failure without an unauthenticated retry', async reason => {
  const start = vi.fn(async () => { throw new ShelfMcpStartupError(reason, new Error('details')); });
  const report = vi.fn();
  const log = vi.fn();
  const lifecycle = createShelfMcpLifecycle({ start, report, log });
  expect(await lifecycle.getEndpoint()).toBeNull();
  expect(await lifecycle.getEndpoint()).toBeNull();
  expect(start).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledExactlyOnceWith({ state: SHELF_MCP_STATE.UNAVAILABLE, reason });
  expect(log).toHaveBeenCalledTimes(1);
});

it('only a new lifecycle retries after failure', async () => {
  const deps = { start: vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue({ url: 'new' }), report: vi.fn(), log: vi.fn() };
  const old = createShelfMcpLifecycle(deps);
  expect(await old.getEndpoint()).toBeNull();
  expect(await old.getEndpoint()).toBeNull();
  expect(await createShelfMcpLifecycle(deps).getEndpoint()).toEqual({ url: 'new' });
});
