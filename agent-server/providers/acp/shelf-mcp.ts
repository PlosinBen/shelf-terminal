// Shelf's built-in bridge, hosted as an in-process HTTP MCP server (official
// @modelcontextprotocol/sdk, stateless StreamableHTTP). ACP agents (copilot)
// connect to it via a standard http `mcpServers` entry — the transport GitHub's
// docs say copilot supports, and the same shape Zed forwards. In-process means
// tool handlers can reach main (runBridgeTool); a stdio subprocess couldn't.
//
// Live-verified: copilot --acp connects to this session/new-forwarded http MCP
// server and executes its tools (the shelf_ping probe returned "pong").
//
// Stateless pattern per the SDK's simpleStatelessStreamableHttp example: a fresh
// McpServer + transport PER request, closed on response end.

import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WEB_FETCH_TOOL, BROWSER_OPEN_TOOL } from '@shared/web-session';
import {
  runBridgeTool,
  APP_SKILL_LIST_DESC, APP_SKILL_GET_DESC, APP_SKILL_CREATE_DESC, APP_SKILL_UPDATE_DESC,
  APP_SKILL_READ_FILE_DESC, APP_SKILL_WRITE_FILE_DESC, APP_SKILL_DELETE_FILE_DESC,
  WEB_FETCH_DESC, BROWSER_OPEN_DESC,
} from '../../app-tool-tools';

export interface ShelfMcpHandle {
  /** URL to advertise as an http `McpServer` entry (127.0.0.1, ephemeral port). */
  url: string;
  close(): void;
}

/** One bridge tool's result → MCP tool result (text + optional isError). */
function toToolResult(r: { text: string; isError: boolean }) {
  return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
}

/**
 * Build the Shelf bridge MCP server: the SAME 9 app-level tools claude/copilot
 * expose (app-skill CRUD + web_fetch/browser_open), handlers reusing the shared
 * `runBridgeTool` (→ main). Same tool NAMES so the model sees a consistent surface
 * across providers; the agent namespaces them (copilot: `shelf-<name>`).
 */
function buildShelfMcpServer(): McpServer {
  const server = new McpServer({ name: 'shelf', version: '1.0.0' });

  server.registerTool('list_app_skills', { description: APP_SKILL_LIST_DESC },
    async () => toToolResult(await runBridgeTool('app_skill.list', {})));

  server.registerTool('get_app_skill',
    { description: APP_SKILL_GET_DESC, inputSchema: { name: z.string().describe('skill folder name from list_app_skills') } },
    async ({ name }) => toToolResult(await runBridgeTool('app_skill.get', { name })));

  server.registerTool('create_app_skill',
    { description: APP_SKILL_CREATE_DESC, inputSchema: { content: z.string().describe('full SKILL.md (frontmatter name+description + body)') } },
    async ({ content }) => toToolResult(await runBridgeTool('app_skill.create', { content })));

  server.registerTool('update_app_skill',
    { description: APP_SKILL_UPDATE_DESC, inputSchema: { name: z.string().describe('current skill folder name'), content: z.string().describe('full new SKILL.md') } },
    async ({ name, content }) => toToolResult(await runBridgeTool('app_skill.update', { name, content })));

  server.registerTool('read_app_skill_file',
    { description: APP_SKILL_READ_FILE_DESC, inputSchema: { name: z.string().describe('skill folder name'), path: z.string().describe('folder-relative aux-file path from get_app_skill `files`') } },
    async ({ name, path }) => toToolResult(await runBridgeTool('app_skill.read_file', { name, path })));

  server.registerTool('write_app_skill_file',
    { description: APP_SKILL_WRITE_FILE_DESC, inputSchema: { name: z.string().describe('skill folder name'), path: z.string().describe('folder-relative aux-file path (no leading slash, no ..)'), content: z.string().describe('file content') } },
    async ({ name, path, content }) => toToolResult(await runBridgeTool('app_skill.write_file', { name, path, content })));

  server.registerTool('delete_app_skill_file',
    { description: APP_SKILL_DELETE_FILE_DESC, inputSchema: { name: z.string().describe('skill folder name'), path: z.string().describe('folder-relative aux-file path') } },
    async ({ name, path }) => toToolResult(await runBridgeTool('app_skill.delete_file', { name, path })));

  server.registerTool(WEB_FETCH_TOOL,
    { description: WEB_FETCH_DESC, inputSchema: {
      url: z.string().describe('absolute http(s) URL of the internal service'),
      method: z.string().optional().describe('HTTP method (default GET)'),
      headers: z.record(z.string(), z.string()).optional().describe('extra request headers, e.g. {"kbn-xsrf":"true"}'),
      body: z.string().optional().describe('request body, e.g. a JSON query string'),
    } },
    async ({ url, method, headers, body }) => toToolResult(await runBridgeTool('web.fetch', { url, method, headers, body })));

  server.registerTool(BROWSER_OPEN_TOOL,
    { description: BROWSER_OPEN_DESC, inputSchema: {
      url: z.string().describe('absolute http(s) URL to open in a visible Web tab for the user to log in'),
      reason: z.string().optional().describe('short explanation of why this page must be opened (shown in the approval popup)'),
    } },
    async ({ url, reason }) => toToolResult(await runBridgeTool('web.open', { url, reason })));

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
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let parsed: unknown;
      try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = undefined; }
      // Fresh server + transport per request (stateless — avoids cross-request state).
      const server = buildShelfMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
      } catch {
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
