import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { bridgeToolArgs, runBridgeTool, SHELF_BRIDGE_TOOLS } from '../../app-tool-tools';

// Use the project's MCP/Zod pair: Claude's bundled converter loses constraints
// from newer Zod schemas. See agent-providers#55.
export function createShelfSdkServer(): McpSdkServerConfigWithInstance {
  const instance = new McpServer({ name: 'shelf', version: '1.0.0' });
  for (const definition of SHELF_BRIDGE_TOOLS) {
    instance.registerTool(definition.name, {
      description: definition.description,
      inputSchema: definition.inputSchema,
    }, async (args) => {
      const { text, isError } = await runBridgeTool(definition.operation, bridgeToolArgs(definition, args));
      return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
    });
  }
  return { type: 'sdk', name: 'shelf', instance };
}
