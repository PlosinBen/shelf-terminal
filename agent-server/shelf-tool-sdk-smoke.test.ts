import { describe, expect, it, vi } from 'vitest';
import { createShelfSdkServer } from './providers/claude/shelf-tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { WORKTREE_MERGE as M } from '@shared/worktree-merge';
import { SHELF_BRIDGE_TOOLS } from './app-tool-tools';

const { callMainMock } = vi.hoisted(() => ({ callMainMock: vi.fn() }));
vi.mock('./app-tool-client', () => ({ callMain: callMainMock }));

// Exercise the production factory and real MCP transport, without model calls
// or executing main RPC operations.
describe('Shelf in-process tools for Claude', () => {
  it('constructs and advertises every shared tool with its current schema', async () => {
    const server = createShelfSdkServer();
    const client = new Client({ name: 'shelf-sdk-smoke', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      expect(server.type).toBe('sdk');
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toEqual(SHELF_BRIDGE_TOOLS.map(({ name }) => name));
      for (const definition of SHELF_BRIDGE_TOOLS) {
        expect(tools.find(({ name }) => name === definition.name)).toMatchObject({
          name: definition.name,
          description: definition.description,
          inputSchema: z.toJSONSchema(z.object(definition.inputSchema), { target: 'draft-7', io: 'input' }),
        });
      }
      expect(callMainMock).not.toHaveBeenCalled();
      for (const args of [{}, { targetBranch: '' }, { targetBranch: 42 }]) {
        expect(await client.callTool({ name: M.TOOL, arguments: args })).toMatchObject({ isError: true });
      }
      expect(callMainMock).not.toHaveBeenCalled();
      callMainMock.mockResolvedValue({ ok: true, data: 'merged' });
      expect(await client.callTool({ name: M.TOOL, arguments: { targetBranch: 'main' } }))
        .toEqual({ content: [{ type: 'text', text: 'merged' }] });
      expect(callMainMock).toHaveBeenCalledExactlyOnceWith(M.OP, { targetBranch: 'main' });
    } finally {
      await client.close();
      await server.instance.close();
    }
  });
});
