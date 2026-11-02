import { expect, it, vi } from 'vitest';
import { createShelfMcpAuthority } from '../src/main/agent/shelf-mcp-authority';
import { SHELF_MCP, SHELF_MCP_FAILURE, SHELF_MCP_STATE } from '@shared/shelf-mcp';
import { initAppToolClient, resolveAppToolResult } from './app-tool-client';
import { startShelfMcpServer, type ShelfMcpHandle } from './shelf-mcp';
import { createShelfMcpLifecycle } from './shelf-mcp-lifecycle';

it('fails closed on a real bootstrap rejection, retries in a new lifecycle, and does not treat bad HTTP callers as an outage', async () => {
  const authority = createShelfMcpAuthority();
  let rejectBootstrap = true;
  const requests: string[] = [];
  initAppToolClient(request => {
    requests.push(request.op);
    queueMicrotask(() => resolveAppToolResult(request.requestId, rejectBootstrap
      ? { ok: false, error: 'main rejected bootstrap' }
      : { ok: true, data: authority.authorize('p', 'agent', request.args.endpointId as string) }));
  });
  const report = vi.fn();
  let host: ShelfMcpHandle | undefined;
  const start = async () => host = await startShelfMcpServer();
  const old = createShelfMcpLifecycle({ start, report, log: vi.fn() });
  expect(await old.getEndpoint()).toBeNull();
  expect(host).toBeUndefined();
  rejectBootstrap = false;
  expect(await old.getEndpoint()).toBeNull();
  expect(requests).toEqual([SHELF_MCP.AUTHORIZE]);
  const fresh = createShelfMcpLifecycle({ start, report, log: vi.fn() });
  const endpoint = await fresh.getEndpoint();
  try {
    expect(endpoint).not.toBeNull();
    expect(report.mock.calls).toEqual([
      [{ state: SHELF_MCP_STATE.UNAVAILABLE, reason: SHELF_MCP_FAILURE.AUTHORIZATION }],
      [{ state: SHELF_MCP_STATE.AVAILABLE }],
    ]);
    expect((await fetch(endpoint!.url, { method: 'POST', body: '{}' })).status).toBe(401);
    const response = await fetch(endpoint!.url, {
      method: 'POST', headers: { ...endpoint!.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(200);
    expect(report).toHaveBeenCalledTimes(2);
  } finally { host?.close(); }
});
