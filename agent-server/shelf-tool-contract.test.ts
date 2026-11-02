import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startShelfMcpServer, type ShelfMcpHandle } from './shelf-mcp';

const { callMainMock, sdkQueryMock } = vi.hoisted(() => ({ callMainMock: vi.fn(), sdkQueryMock: vi.fn() }));
vi.mock('./app-tool-client', () => ({ callMain: callMainMock }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkQueryMock,
  tool: (name: string, description: string, schema: z.ZodRawShape, handler: ClaudeTool['handler']) =>
    ({ name, description, schema, handler }),
  createSdkMcpServer: (config: unknown) => config,
}));
import { createClaudeBackend } from './providers/claude';

interface ClaudeTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler(args: Record<string, unknown>): Promise<unknown>;
}

// Independent expectations: changing a shared definition must not silently change
// both adapters and make parity alone pass.
const cases = [
  { name: 'list_app_skills', op: 'app_skill.list', args: {} },
  { name: 'get_app_skill', op: 'app_skill.get', args: { name: 'sample' } },
  { name: 'create_app_skill', op: 'app_skill.create', args: { content: 'skill' } },
  { name: 'update_app_skill', op: 'app_skill.update', args: { name: 'sample', content: 'skill' } },
  { name: 'read_app_skill_file', op: 'app_skill.read_file', args: { name: 'sample', path: 'ref.md' } },
  { name: 'write_app_skill_file', op: 'app_skill.write_file', args: { name: 'sample', path: 'ref.md', content: 'text' } },
  { name: 'delete_app_skill_file', op: 'app_skill.delete_file', args: { name: 'sample', path: 'ref.md' } },
  { name: 'browser_fetch', op: 'web.fetch', args: { url: 'https://example.com', method: 'POST', headers: { test: 'value' }, body: 'query' } },
  { name: 'browser_open', op: 'web.open', args: { url: 'https://example.com', reason: 'login' } },
  { name: 'propose_worktree_create', op: 'worktree.propose_create', args: { branch: 'feature', note: 'one.md', notes: ['two.md'] } },
  { name: 'propose_worktree_finish', op: 'worktree.propose_finish', args: {} },
] as const;

describe('Shelf tool contracts across Claude SDK and HTTP MCP', () => {
  let host: ShelfMcpHandle;
  let client: Client;
  let claudeTools: ClaudeTool[];

  beforeAll(async () => {
    sdkQueryMock.mockImplementation(() => {
      const probe = (async function* () { yield { type: 'system', subtype: 'init', session_id: 'contract' }; })();
      return Object.assign(probe, { mcpServerStatus: async () => [], supportedCommands: async () => [] });
    });
    const backend = createClaudeBackend();
    await backend.query({ prompt: '/mcp', cwd: '/tmp' }, () => {});
    claudeTools = sdkQueryMock.mock.calls[0][0].options.mcpServers.shelf.tools;
    host = await startShelfMcpServer();
    client = new Client({ name: 'contract-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(host.url)));
  });
  afterAll(async () => { await client?.close(); host?.close(); });
  beforeEach(() => { callMainMock.mockReset(); });

  it('preserves each adapter’s advertised names, descriptions and schemas', async () => {
    const httpTools = (await client.listTools()).tools;
    expect(claudeTools.map(tool => tool.name)).toEqual(cases.map(tool => tool.name));
    expect(httpTools.map(tool => tool.name)).toEqual(cases.map(tool => tool.name));
    expect(claudeTools.map(({ name, description, schema }) => ({
      name, description, inputSchema: z.toJSONSchema(z.object(schema)),
    }))).toMatchSnapshot('Claude SDK surface');
    expect(httpTools).toMatchSnapshot('HTTP MCP surface');
  });

  for (const adapter of ['Claude', 'HTTP'] as const) {
    const invoke = (name: string, args: Record<string, unknown>) => adapter === 'HTTP'
      ? client.callTool({ name, arguments: args })
      : claudeTools.find(tool => tool.name === name)!.handler(args);

    describe(adapter, () => {
      it.each(cases)('$name forwards only declared arguments to $op', async ({ name, op, args }) => {
        callMainMock.mockResolvedValue({ ok: true, data: { result: 'ok' } });
        await expect(invoke(name, { ...args, extra: 'not forwarded' })).resolves.toEqual({
          content: [{ type: 'text', text: '{"result":"ok"}' }],
        });
        expect(callMainMock).toHaveBeenCalledExactlyOnceWith(op, args);
      });

      it.each(cases)('$name preserves bridge failures', async ({ name, args }) => {
        callMainMock.mockResolvedValue({ ok: false, error: 'denied' });
        await expect(invoke(name, args)).resolves.toEqual({
          content: [{ type: 'text', text: 'Error: denied' }], isError: true,
        });
      });

      it.each([
        { name: 'browser_fetch', args: { url: 'https://example.com' }, op: 'web.fetch', expected: { url: 'https://example.com', method: undefined, headers: undefined, body: undefined } },
        { name: 'browser_open', args: { url: 'https://example.com' }, op: 'web.open', expected: { url: 'https://example.com', reason: undefined } },
        { name: 'propose_worktree_create', args: {}, op: 'worktree.propose_create', expected: { branch: undefined, note: undefined, notes: undefined } },
      ])('$name keeps omitted optional arguments compatible', async ({ name, args, op, expected }) => {
        callMainMock.mockResolvedValue({ ok: true, data: 'ok' });
        await expect(invoke(name, args)).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
        expect(callMainMock).toHaveBeenCalledExactlyOnceWith(op, expected);
      });
    });
  }

  it('rejects invalid arguments before HTTP dispatch to main', async () => {
    const result = await client.callTool({ name: 'get_app_skill', arguments: { name: 42 } });
    expect(result.isError).toBe(true);
    expect(callMainMock).not.toHaveBeenCalled();
  });

  it('keeps Claude’s schema available to its SDK for validation', () => {
    const tool = claudeTools.find(tool => tool.name === 'get_app_skill')!;
    expect(z.object(tool.schema).safeParse({ name: 42 }).success).toBe(false);
  });
});
