import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createShelfMcpAuthority } from '../src/main/agent/shelf-mcp-authority';
import { SHELF_MCP } from '@shared/shelf-mcp';
import { initAppToolClient, resolveAppToolResult } from './app-tool-client';
import { closeSharedShelfMcp, getSharedShelfMcp } from './shelf-mcp';

it('bootstraps via the real RPC client, serves authenticated tools, and revokes on shutdown', async () => {
  const authority = createShelfMcpAuthority();
  const operations: string[] = [];
  initAppToolClient(request => {
    // Exercise the actual request/result correlation and JSON wire boundary,
    // without starting a provider CLI or performing client-owned mutations.
    const frame = JSON.parse(JSON.stringify(request));
    operations.push(frame.op);
    const data = frame.op === SHELF_MCP.AUTHORIZE
      ? authority.authorize('p', 'trusted-session', frame.args.endpointId)
      : { skills: [] };
    const result = JSON.parse(JSON.stringify({ ok: true, data }));
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    queueMicrotask(() => resolveAppToolResult(frame.requestId, result));
  });
  const client = new Client({ name: 'bootstrap-test', version: '1' });
  const [host, sameHost] = await Promise.all([getSharedShelfMcp(), getSharedShelfMcp()]);
  try {
    expect(host).toBe(sameHost);
    await client.connect(new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: host.headers } }));
    expect((await client.listTools()).tools).toHaveLength(11);
    expect(await client.callTool({ name: 'list_app_skills', arguments: {} })).toEqual({ content: [{ type: 'text', text: '{"skills":[]}' }] });
    expect(operations).toEqual([SHELF_MCP.AUTHORIZE, 'app_skill.list']);
  } finally {
    await client.close();
    closeSharedShelfMcp();
  }
  await expect(getSharedShelfMcp()).rejects.toThrow('shutting down');
  await expect(fetch(host.url, { method: 'POST', headers: host.headers, body: '{}' })).rejects.toThrow();
});
