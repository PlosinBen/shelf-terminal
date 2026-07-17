// Shelf MCP config → ACP McpServer mapping (shared acp/ toolkit — protocol
// shaping, semantics-free). ACP's `session/new` takes `mcpServers: McpServer[]`;
// Shelf persists servers as `McpServerBlock` (stdio | http). This maps ONE side
// to the other, ONCE, for EVERY ACP provider (codex/copilot/future) — vs the
// bespoke SDKs where each provider wrote its own (copilot's `toCopilotMcpConfig`).
//
// `${VAR}` resolution + validation already happened in `mcp-config.ts`
// (loadProjectedMcpServers); this is a pure shape transform.

import type { McpServer } from '@agentclientprotocol/sdk';
import type { McpServersFile } from '@shared/mcp';

/** Map an env/header record to ACP's `[{ name, value }]` list form. */
function toNameValueList(map: Record<string, string> | undefined): Array<{ name: string; value: string }> {
  return Object.entries(map ?? {}).map(([name, value]) => ({ name, value }));
}

/** Shelf's parsed MCP servers → ACP `McpServer[]` for `session/new`. */
export function toAcpMcpServers(servers: McpServersFile): McpServer[] {
  return Object.entries(servers).map(([name, block]): McpServer => {
    if (block.type === 'stdio') {
      // ACP McpServerStdio is the untagged union member (no `type`).
      return { name, command: block.command, args: block.args ?? [], env: toNameValueList(block.env) };
    }
    return { type: 'http', name, url: block.url, headers: toNameValueList(block.headers) };
  });
}
