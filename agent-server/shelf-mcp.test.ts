import { WORKTREE_MERGE as M } from '@shared/worktree-merge';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createShelfMcpAuthority } from '../src/main/agent/shelf-mcp-authority';
import { SHELF_MCP, SHELF_MCP_FAILURE } from '@shared/shelf-mcp';
import { DELEGATION } from '@shared/agent-delegation';
import { runBridgeTool } from './app-tool-tools';
import * as logger from './server-logger';
const authority = createShelfMcpAuthority();
vi.mock('./app-tool-client', () => ({
  callMain: async (op: string, args: { endpointId: string }) => {
    if (op !== SHELF_MCP.AUTHORIZE) throw new Error('Unexpected bootstrap operation');
    return { ok: true, data: authority.authorize('p', 'agent', args.endpointId) };
  },
}));
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startShelfMcpServer, type ShelfMcpHandle } from './shelf-mcp';

vi.mock('./app-tool-tools', async (importOriginal) => ({
  ...await importOriginal<typeof import('./app-tool-tools')>(),
  runBridgeTool: vi.fn(async () => ({ text: 'ok', isError: false })),
}));

// Exercises the real in-process HTTP MCP server end-to-end (a live MCP client
// connects over HTTP and lists tools) — proving the transport + tool registration
// the way copilot --acp consumes it. Tool HANDLERS call runBridgeTool → main, so
// their execution is verified live, not here.
describe('shelf MCP bridge server', () => {
  let handle: ShelfMcpHandle | undefined;
  afterEach(() => { handle?.close(); handle = undefined; });

  it('rejects unauthenticated calls before tool dispatch', async () => {
    handle = await startShelfMcpServer();
    const callsBefore = vi.mocked(runBridgeTool).mock.calls.length;
    const response = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_app_skills', arguments: {} } }),
    });
    await response.text();
    expect(response.status).toBe(401);
    expect(vi.mocked(runBridgeTool).mock.calls.length).toBe(callsBefore);
  });

  it.each([
    { path: '/other', header: {}, status: 404 },
    { path: '/mcp?extra=1', header: {}, status: 404 },
    { path: '/mcp', header: { Origin: 'https://other.example' }, status: 403 },
    { path: '/mcp', header: { Origin: 'null' }, status: 403 },
    { path: '/mcp', header: { Host: 'other.example' }, status: 403 },
    { path: '/mcp', header: { Authorization: 'Bearer forged' }, status: 401 },
  ])('rejects invalid path/host/origin/credential $path $header before dispatch', async ({ path, header, status }) => {
    handle = await startShelfMcpServer();
    const callsBefore = vi.mocked(runBridgeTool).mock.calls.length;
    const result = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(new URL(path, handle!.url), {
        method: 'POST', headers: { ...handle!.headers, ...header, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_app_skills', arguments: {} } }));
    });
    expect(result).toBe(status);
    expect(vi.mocked(runBridgeTool).mock.calls.length).toBe(callsBefore);
  });

  it('accepts a valid signature with the endpoint’s own Origin', async () => {
    handle = await startShelfMcpServer();
    const response = await fetch(handle.url, {
      method: 'POST', headers: { ...handle.headers, Origin: new URL(handle.url).origin, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_app_skills', arguments: {} } }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('ok');
  });

  it('does not accept another endpoint’s token, even in the same Project', async () => {
    handle = await startShelfMcpServer();
    const other = await startShelfMcpServer();
    try {
      const response = await fetch(handle.url, { method: 'POST', headers: other.headers, body: '{}' });
      await response.text();
      expect(response.status).toBe(401);
    } finally { other.close(); }
  });

  it('rejects non-POST requests and advertises only POST', async () => {
    handle = await startShelfMcpServer();
    const response = await fetch(handle.url, { headers: handle.headers });
    await response.text();
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('does not expose a listener if authorization fails', async () => {
    await expect(startShelfMcpServer(async () => { throw new Error('bootstrap failed'); })).rejects.toMatchObject({
      reason: SHELF_MCP_FAILURE.AUTHORIZATION, cause: new Error('bootstrap failed'),
    });
  });

  it('stops accepting the token when the endpoint closes', async () => {
    handle = await startShelfMcpServer();
    const { url, headers } = handle;
    handle.close();
    handle.close(); // shutdown is idempotent
    await expect(fetch(url, { method: 'POST', headers, body: '{}' })).rejects.toThrow();
  });

  it('serves the app-level bridge tools over HTTP', async () => {
    const log = vi.spyOn(logger, 'serverLog');
    handle = await startShelfMcpServer();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: { headers: handle.headers } }));
    const { tools } = await client.listTools();
    await client.close();
    try {
      expect(log).toHaveBeenCalledWith('debug', 'shelf-mcp', 'Discovery response', expect.objectContaining({
        method: 'tools/list', status: 200, toolNames: tools.map(tool => tool.name),
      }));
    } finally { log.mockRestore(); }

    expect(tools.map((t) => t.name).sort()).toEqual([
      'browser_fetch',
      'browser_open',
      'create_app_skill',
      'delete_app_skill_file',
      'get_app_skill',
      'list_app_skills',
      M.TOOL,
      'propose_worktree_create',
      'propose_worktree_finish',
      'read_app_skill_file',
      DELEGATION.TOOL.STATUS,
      DELEGATION.TOOL.PROGRESS,
      DELEGATION.TOOL.SELECT,
      DELEGATION.TOOL.SEND,
      DELEGATION.TOOL.START,
      DELEGATION.TOOL.RESULT,
      'update_app_skill',
      'write_app_skill_file',
    ]);
    expect(tools.find((t) => t.name === 'propose_worktree_create')?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        branch: { type: 'string' },
        agent: { type: 'string' },
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
        headers: { ...handle!.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
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
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: { headers: handle.headers } }));
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
      headers: { ...handle.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body,
    });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
  });

  it('limits tool argument elements while allowing a call at the boundary', async () => {
    handle = await startShelfMcpServer();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: { headers: handle.headers } }));
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
