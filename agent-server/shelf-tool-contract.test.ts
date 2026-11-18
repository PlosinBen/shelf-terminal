import { WORKTREE_MERGE as M } from '@shared/worktree-merge';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { CODEX_PROVIDER } from '../src/shared/agent-providers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startShelfMcpServer, type ShelfMcpHandle } from './shelf-mcp';
import { createShelfMcpAuthority } from '../src/main/agent/shelf-mcp-authority';

const { callMainMock, sdkQueryMock } = vi.hoisted(() => ({ callMainMock: vi.fn(), sdkQueryMock: vi.fn() }));
vi.mock('./app-tool-client', () => ({ callMain: callMainMock }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkQueryMock,
}));
import { createClaudeBackend } from './providers/claude';

// Independent expectations: changing a shared definition must not silently change
// both adapters and make parity alone pass.
const cases = [
  { name: 'shelf_select_agent', op: 'agent_delegation.select', args: {} },
  { name: 'shelf_start_delegation', op: 'agent_delegation.start', args: { projectId: 'p', agentViewId: 'view', content: 'verify A' } },
  { name: 'shelf_send_delegation', op: 'agent_delegation.send', args: { delegationId: 'delegation', content: 'verify B' } },
  { name: 'shelf_delegation_status', op: 'agent_delegation.status', args: { delegationId: 'delegation' } },
  { name: 'shelf_report_progress', op: 'agent_delegation.progress', args: { delegationId: 'delegation', content: 'checking A' } },
  { name: 'shelf_submit_result', op: 'agent_delegation.result', args: { delegationId: 'delegation', content: 'A holds' } },
  { name: 'list_app_skills', op: 'app_skill.list', args: {} },
  { name: 'get_app_skill', op: 'app_skill.get', args: { name: 'sample' } },
  { name: 'create_app_skill', op: 'app_skill.create', args: { content: 'skill' } },
  { name: 'update_app_skill', op: 'app_skill.update', args: { name: 'sample', content: 'skill' } },
  { name: 'read_app_skill_file', op: 'app_skill.read_file', args: { name: 'sample', path: 'ref.md' } },
  { name: 'write_app_skill_file', op: 'app_skill.write_file', args: { name: 'sample', path: 'ref.md', content: 'text' } },
  { name: 'delete_app_skill_file', op: 'app_skill.delete_file', args: { name: 'sample', path: 'ref.md' } },
  { name: 'browser_fetch', op: 'web.fetch', args: { url: 'https://example.com', method: 'POST', headers: { test: 'value' }, body: 'query' } },
  { name: 'browser_open', op: 'web.open', args: { url: 'https://example.com', reason: 'login' } },
  { name: 'propose_worktree_create', op: 'worktree.propose_create', args: { branch: 'feature', note: 'one.md', notes: ['two.md'], agent: CODEX_PROVIDER } },
  { name: M.TOOL, op: M.OP, args: { targetBranch: 'main' } },
  { name: 'propose_worktree_finish', op: 'worktree.propose_finish', args: {} },
] as const;

describe('Shelf tool contracts across Claude SDK and HTTP MCP', () => {
  let host: ShelfMcpHandle;
  let client: Client;
  let claudeClient: Client;
  let claudeServer: McpSdkServerConfigWithInstance;

  beforeAll(async () => {
    sdkQueryMock.mockImplementation(() => {
      const probe = (async function* () { yield { type: 'system', subtype: 'init', session_id: 'contract' }; })();
      return Object.assign(probe, { mcpServerStatus: async () => [], supportedCommands: async () => [] });
    });
    const backend = createClaudeBackend();
    await backend.query({ prompt: '/mcp', cwd: '/tmp' }, () => {});
    claudeServer = sdkQueryMock.mock.calls[0][0].options.mcpServers.shelf;
    claudeClient = new Client({ name: 'claude-contract-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await claudeServer.instance.connect(serverTransport);
    await claudeClient.connect(clientTransport);
    const authority = createShelfMcpAuthority();
    callMainMock.mockImplementation(async (_op, args) => ({ ok: true, data: authority.authorize('p', 'agent', args.endpointId) }));
    host = await startShelfMcpServer();
    client = new Client({ name: 'contract-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(host.url), { requestInit: { headers: host.headers } }));
  });
  afterAll(async () => {
    await claudeClient?.close();
    await claudeServer?.instance.close();
    await client?.close();
    host?.close();
  });
  beforeEach(() => { callMainMock.mockReset(); });

  it('preserves each adapter’s advertised names, descriptions and schemas', async () => {
    const httpTools = (await client.listTools()).tools;
    const claudeTools = (await claudeClient.listTools()).tools;
    expect(claudeTools.map(tool => tool.name)).toEqual(cases.map(tool => tool.name));
    expect(httpTools.map(tool => tool.name)).toEqual(cases.map(tool => tool.name));
    expect(claudeTools.map(({ name, description, inputSchema }) => ({
      name, description, inputSchema,
    }))).toMatchSnapshot('Claude SDK surface');
    expect(httpTools).toMatchSnapshot('HTTP MCP surface');
  });

  for (const adapter of ['Claude', 'HTTP'] as const) {
    const invoke = (name: string, args: Record<string, unknown>) => adapter === 'HTTP'
      ? client.callTool({ name, arguments: args })
      : claudeClient.callTool({ name, arguments: args });

    describe(adapter, () => {
      it.each(cases)('$name forwards only declared arguments to $op', async ({ name, op, args }) => {
        callMainMock.mockResolvedValue({ ok: true, data: { result: 'ok' } });
        await expect(invoke(name, { ...args, extra: 'not forwarded' })).resolves.toEqual({
          content: [{ type: 'text', text: '{"result":"ok"}' }],
        });
        expect(callMainMock).toHaveBeenCalledExactlyOnceWith(op, args);
      });

      it('preserves a structured merge failure and marks it as an MCP error', async () => {
        const data = { outcome: 'non-ff', targetBranch: 'main', error: 'Git rejected non-fast-forward' };
        callMainMock.mockResolvedValue({ ok: false, error: data.error, data });
        await expect(invoke('merge_worktree', { targetBranch: 'main' })).resolves.toEqual({
          content: [{ type: 'text', text: JSON.stringify(data) }], isError: true,
        });
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
        { name: 'propose_worktree_create', args: {}, op: 'worktree.propose_create', expected: { branch: undefined, note: undefined, notes: undefined, agent: undefined } },
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

  it('rejects invalid arguments before Claude dispatch to main', async () => {
    expect(await claudeClient.callTool({ name: 'get_app_skill', arguments: { name: 42 } }))
      .toMatchObject({ isError: true });
    expect(callMainMock).not.toHaveBeenCalled();
  });
});
