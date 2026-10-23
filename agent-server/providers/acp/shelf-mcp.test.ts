import { describe, it, expect, afterEach, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startShelfMcpServer, type ShelfMcpHandle } from './shelf-mcp';

vi.mock('../../app-tool-tools', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../app-tool-tools')>(),
  runBridgeTool: vi.fn(async () => ({ text: 'ok', isError: false })),
}));

// Exercises the real in-process HTTP MCP server end-to-end (a live MCP client
// connects over HTTP and lists tools) — proving the transport + tool registration
// the way copilot --acp consumes it. Tool HANDLERS call runBridgeTool → main, so
// their execution is verified live, not here.
describe('shelf MCP bridge server', () => {
  let handle: ShelfMcpHandle | undefined;
  afterEach(() => { handle?.close(); handle = undefined; });

  it('serves the app-level bridge tools over HTTP', async () => {
    handle = await startShelfMcpServer();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'browser_fetch',
      'browser_open',
      'create_app_skill',
      'delete_app_skill_file',
      'get_app_skill',
      'list_app_skills',
      'propose_worktree_create',
      'propose_worktree_finish',
      'read_app_skill_file',
      'update_app_skill',
      'write_app_skill_file',
    ]);
    expect(tools.find((t) => t.name === 'propose_worktree_create')?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        branch: { type: 'string' },
        note: { type: 'string' },
        notes: { type: 'array', items: { type: 'string' } },
      },
    });
  });

  it('rejects an HTTP body over 2 MiB and remains usable afterward', async () => {
    handle = await startShelfMcpServer();
    const limit = 2 * 1024 * 1024;
    const request = { jsonrpc: '2.0', id: 1, method: 'ping', params: {}, padding: '' };
    const emptyBody = JSON.stringify(request);
    const oversizedBody = JSON.stringify({
      ...request,
      padding: 'x'.repeat(limit + 1 - Buffer.byteLength(emptyBody)),
    });
    expect(Buffer.byteLength(oversizedBody)).toBe(limit + 1);

    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(handle!.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      });
      request.on('error', reject);
      request.write(oversizedBody.slice(0, limit));
      request.end(oversizedBody.slice(limit));
    });
    expect(status).toBe(413);

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it('accepts a request at the 2 MiB byte boundary', async () => {
    handle = await startShelfMcpServer();
    const limit = 2 * 1024 * 1024;
    const request = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    };
    const body = JSON.stringify({
      ...request,
      params: {
        ...request.params,
        clientInfo: { ...request.params.clientInfo, name: 'x'.repeat(limit - Buffer.byteLength(JSON.stringify(request)) + 4) },
      },
    });
    expect(Buffer.byteLength(body)).toBe(limit);
    const response = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body,
    });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
  });

  it('limits tool argument elements while allowing a call at the boundary', async () => {
    handle = await startShelfMcpServer();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    const headers = Object.fromEntries(Array.from({ length: 1022 }, (_, index) => [`header-${index}`, 'value']));
    const within = await client.callTool({ name: 'browser_fetch', arguments: { url: 'https://example.com', headers } });
    expect(within.isError).not.toBe(true);
    expect(within.content).toEqual([{ type: 'text', text: 'ok' }]);

    const tooMany = await client.callTool({
      name: 'browser_fetch',
      arguments: { url: 'https://example.com', headers: { ...headers, extra: 'value' } },
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('maximum of 1024 elements') }),
    ]));
    await client.close();
  });
});
