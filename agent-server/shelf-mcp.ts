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

import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isJSONRPCResultResponse } from '@modelcontextprotocol/sdk/types.js';
import { runBridgeTool, SHELF_BRIDGE_TOOLS, bridgeToolArgs } from './app-tool-tools';
import { SHELF_MCP, SHELF_MCP_FAILURE, type ShelfMcpEndpoint } from '@shared/shelf-mcp';
import { ShelfMcpStartupError } from './shelf-mcp-lifecycle';
import { requestShelfMcpAuthentication, type ShelfMcpAuthentication } from './shelf-mcp-auth';
import { serverLog } from './server-logger';

export interface ShelfMcpHandle extends ShelfMcpEndpoint {
  /** URL to advertise as an http `McpServer` entry (127.0.0.1, ephemeral port). */
  url: string;
  headers: Readonly<Record<string, string>>;
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

function rejectRequest(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/** Start the in-process shelf MCP HTTP server on an ephemeral localhost port. */
export async function startShelfMcpServer(
  authorize: (endpointId: string) => Promise<ShelfMcpAuthentication> = requestShelfMcpAuthentication,
): Promise<ShelfMcpHandle> {
  // Bootstrap before binding: a failed authorization cannot expose a listener.
  const endpointId = randomUUID();
  const authentication = await authorize(endpointId).catch(error => {
    throw new ShelfMcpStartupError(SHELF_MCP_FAILURE.AUTHORIZATION, error);
  });
  let authority = '';
  let origin = '';
  let active = true;
  const httpServer: Server = createServer((req, res) => {
    if (!active) { rejectRequest(res, 503, 'Shelf MCP endpoint closed'); return; }
    if (req.url !== SHELF_MCP.PATH) { rejectRequest(res, 404, 'Not found'); return; }
    if (req.method !== 'POST') { rejectRequest(res, 405, 'Method not allowed', { Allow: 'POST' }); return; }
    // Origin/Host are defense-in-depth, never authentication. Non-browser
    // clients can omit Origin; all callers still need the signed Bearer.
    let originAllowed = req.headers.origin === undefined;
    if (req.headers.origin !== undefined) {
      try { originAllowed = new URL(req.headers.origin).origin === origin; }
      catch { originAllowed = false; }
    }
    if (req.headers.host?.toLowerCase() !== authority || !originAllowed) {
      rejectRequest(res, 403, 'Forbidden'); return;
    }
    if (!authentication.verifyAuthorization(req.headers.authorization)) {
      serverLog('debug', 'shelf-mcp', 'Unauthorized request', { endpointId, status: 401 });
      rejectRequest(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' }); return;
    }
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
      if (!active) { rejectRequest(res, 503, 'Shelf MCP endpoint closed'); return; }
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
      const method = parsed && typeof parsed === 'object' && 'method' in parsed ? parsed.method : undefined;
      if (method === 'initialize' || method === 'tools/list') {
        let toolNames: string[] | undefined;
        if (method === 'tools/list') {
          const send = transport.send.bind(transport);
          transport.send = (message, options) => {
            if (isJSONRPCResultResponse(message) && Array.isArray(message.result.tools)) {
              toolNames = message.result.tools.map(tool => tool.name);
            }
            return send(message, options);
          };
        }
        res.once('finish', () => serverLog('debug', 'shelf-mcp', 'Discovery response', {
          endpointId, method, status: res.statusCode, toolNames,
        }));
      }
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
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once('error', onError);
    httpServer.listen(0, SHELF_MCP.HOST, () => { httpServer.off('error', onError); resolve(); });
  }).catch(error => { throw new ShelfMcpStartupError(SHELF_MCP_FAILURE.LISTENER, error); });
  const addr = httpServer.address();
  if (!addr || typeof addr !== 'object') {
    httpServer.close();
    throw new ShelfMcpStartupError(SHELF_MCP_FAILURE.LISTENER, new Error('Shelf MCP listener has no TCP address'));
  }
  authority = `${SHELF_MCP.HOST}:${addr.port}`;
  origin = `http://${authority}`;
  httpServer.on('error', error => serverLog('error', 'shelf-mcp', `HTTP host error: ${error.message}`));
  return {
    url: `${origin}${SHELF_MCP.PATH}`,
    headers: authentication.headers,
    close: () => {
      if (!active) return;
      active = false;
      httpServer.close(error => {
        if (error) serverLog('warn', 'shelf-mcp', `HTTP host close failed: ${error.message}`);
      });
    },
  };
}

// Shared singleton: one shelf MCP server per agent-server process (all tabs point
// at the same url). Lazily started on first use.
let shared: Promise<ShelfMcpHandle> | null = null;
let sharedClosed = false;
export function getSharedShelfMcp(): Promise<ShelfMcpHandle> {
  if (sharedClosed) return Promise.reject(new Error('Shelf MCP is shutting down'));
  if (!shared) shared = startShelfMcpServer();
  return shared;
}

/** Immediately revoke the endpoint even while detached tasks are being reaped. */
export function closeSharedShelfMcp(): void {
  sharedClosed = true;
  if (shared) void shared.then(handle => handle.close(), error => {
    serverLog('debug', 'shelf-mcp', `No endpoint to close after startup failure: ${error.message}`);
  });
}
