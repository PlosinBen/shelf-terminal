import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startShelfMcpServer, type ShelfMcpHandle } from './shelf-mcp';

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
});
