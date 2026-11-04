import { describe, expect, it } from 'vitest';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { SHELF_BRIDGE_TOOLS } from './app-tool-tools';

// Contract parity tests mock Claude's SDK builders. Keep these real so an
// SDK/Zod incompatibility cannot pass merely because both adapters share a schema.
// This checks construction and tools/list, not model calls or main RPC handlers.
describe('Shelf tools with the real Claude SDK', () => {
  it('constructs and advertises every shared tool with its current schema', async () => {
    const server = createSdkMcpServer({
      name: 'shelf',
      version: '1.0.0',
      tools: SHELF_BRIDGE_TOOLS.map(definition => tool(
        definition.name,
        definition.description,
        definition.inputSchema,
        async () => { throw new Error('Construction smoke must not execute tools'); },
      )),
    });
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
    } finally {
      await client.close();
      await server.instance.close();
    }
  });
});
