// Shelf's built-in bridge, hosted as an in-process HTTP MCP server (official
// @modelcontextprotocol/sdk, stateless StreamableHTTP). Copilot ACP and Codex
// app-server consume this shared host through their own config adapters.
// In-process means tool handlers can reach main (runBridgeTool); a stdio
// subprocess couldn't.
//
// Live-verified: copilot --acp connects to this session/new-forwarded http MCP
// server and executes its tools (the shelf_ping probe returned "pong").
//
// Stateless pattern per the SDK's simpleStatelessStreamableHttp example: a fresh
// McpServer + transport PER request, closed on response end.

import { createServer, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { runBridgeTool, SHELF_BRIDGE_TOOLS, bridgeToolArgs } from './app-tool-tools';

export interface ShelfMcpHandle {
  /** URL to advertise as an http `McpServer` entry (127.0.0.1, ephemeral port). */
  url: string;
  close(): void;
}

// mcp#10: Bridge calls may contain a full skill file or web request body. Keep the
// request under 2 MiB and the (normally small) argument shape under 1,024
// object members/array elements. The SDK's own body cap is bypassed because
// this HTTP boundary passes a pre-parsed body to its transport.
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_INPUT_ELEMENTS = 1024;

/** One bridge tool's result → MCP tool result (text + optional isError). */
function toToolResult(r: { text: string; isError: boolean }) {
  return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
}

/**
 * HTTP MCP adapter for Shelf's shared tool contracts. It owns MCP registration
 * and result envelopes; tool semantics and main dispatch stay provider-neutral.
 */
function buildShelfMcpServer(): McpServer {
  const server = new McpServer({ name: 'shelf', version: '1.0.0' }, { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS });

  for (const definition of SHELF_BRIDGE_TOOLS) {
    // Preserve the existing no-argument HTTP schema. Claude's SDK instead takes
    // an empty shape; that adaptation belongs in its own provider.
    const config = {
      description: definition.description,
      ...(Object.keys(definition.inputSchema).length ? { inputSchema: definition.inputSchema } : {}),
    };
    server.registerTool(definition.name, config, async (args: Record<string, unknown>) =>
      toToolResult(await runBridgeTool(definition.operation, bridgeToolArgs(definition, args))));
  }

  return server;
}

function methodNotAllowed(res: import('node:http').ServerResponse): void {
  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
}

/** Start the in-process shelf MCP HTTP server on an ephemeral localhost port. */
export async function startShelfMcpServer(): Promise<ShelfMcpHandle> {
  const httpServer: Server = createServer((req, res) => {
    if (req.method !== 'POST') { methodNotAllowed(res); return; } // stateless: no GET/DELETE
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Request body too large' }, id: null }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => {
      rejected = true;
      chunks.length = 0;
      console.warn('[shelf-mcp] request stream failed', error);
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Request stream failed' }, id: null }));
      }
    });
    req.on('end', async () => {
      if (rejected) return;
      const body = Buffer.concat(chunks, receivedBytes).toString('utf8');
      let parsed: unknown;
      try { parsed = body ? JSON.parse(body) : undefined; }
      catch (error) {
        console.warn('[shelf-mcp] invalid request JSON', error);
        parsed = undefined;
      }
      // Fresh server + transport per request (stateless — avoids cross-request state).
      const server = buildShelfMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
      } catch (error) {
        console.error('[shelf-mcp] transport request failed', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
        }
      }
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => { try { httpServer.close(); } catch { /* best-effort */ } },
  };
}

// Shared singleton: one shelf MCP server per agent-server process (all tabs point
// at the same url). Lazily started on first use.
let shared: Promise<ShelfMcpHandle> | null = null;
export function getSharedShelfMcp(): Promise<ShelfMcpHandle> {
  if (!shared) shared = startShelfMcpServer();
  return shared;
}
