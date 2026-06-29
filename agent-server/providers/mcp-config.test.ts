import { describe, it, expect } from 'vitest';
import { resolveVarRefs, resolveServerVars, parseMcpConfig } from './mcp-config';
import type { McpServerConfig } from '@shared/mcp';

describe('resolveVarRefs', () => {
  it('replaces ${VAR} tokens and reports missing ones', () => {
    expect(resolveVarRefs('Bearer ${TOKEN}', { TOKEN: 'abc' })).toEqual({ resolved: 'Bearer abc', missing: [] });
    expect(resolveVarRefs('${A}-${B}', { A: '1', B: '2' })).toEqual({ resolved: '1-2', missing: [] });
    const r = resolveVarRefs('${GONE}', {});
    expect(r.resolved).toBe('');
    expect(r.missing).toEqual(['GONE']);
  });
  it('leaves plain strings untouched', () => {
    expect(resolveVarRefs('ghp_literal', {})).toEqual({ resolved: 'ghp_literal', missing: [] });
  });
});

describe('resolveServerVars', () => {
  it('resolves stdio env refs', () => {
    const s: McpServerConfig = { type: 'stdio', name: 'gh', command: 'node', env: { TOKEN: '${T}' } };
    const out = resolveServerVars(s, { T: 'secret' });
    expect(out.missing).toEqual([]);
    expect((out.server as any).env).toEqual({ TOKEN: 'secret' });
  });
  it('resolves http header refs and collects missing', () => {
    const s: McpServerConfig = { type: 'http', name: 'api', url: 'https://x', headers: { Authorization: 'Bearer ${K}' } };
    const out = resolveServerVars(s, {});
    expect(out.missing).toEqual(['K']);
  });
});

describe('parseMcpConfig (fail-loud)', () => {
  const env = { TOKEN: 'tok' };

  it('parses + resolves valid servers', () => {
    const raw = JSON.stringify([
      { type: 'stdio', name: 'gh', command: 'node', env: { GITHUB_TOKEN: '${TOKEN}' } },
      { type: 'http', name: 'api', url: 'https://x' },
    ]);
    const out = parseMcpConfig(raw, env);
    expect(out.errors).toEqual([]);
    expect(out.servers.map((s) => s.name)).toEqual(['gh', 'api']);
    expect((out.servers[0] as any).env).toEqual({ GITHUB_TOKEN: 'tok' });
  });

  it('drops a server with a missing env ref AND records an error (never silent)', () => {
    const raw = JSON.stringify([
      { type: 'stdio', name: 'gh', command: 'node', env: { T: '${ABSENT}' } },
      { type: 'http', name: 'ok', url: 'https://x' },
    ]);
    const out = parseMcpConfig(raw, env);
    expect(out.servers.map((s) => s.name)).toEqual(['ok']);
    expect(out.errors.join(' ')).toMatch(/gh.*ABSENT/);
  });

  it('drops an invalid-shape server with an error', () => {
    const raw = JSON.stringify([{ type: 'stdio', name: 'bad name', command: 'x' }]);
    const out = parseMcpConfig(raw, env);
    expect(out.servers).toEqual([]);
    expect(out.errors[0]).toMatch(/invalid MCP server/i);
  });

  it('bad JSON / non-array → empty + a loud error', () => {
    expect(parseMcpConfig('{ not json', env).errors[0]).toMatch(/not valid JSON/);
    expect(parseMcpConfig('{"a":1}', env).errors[0]).toMatch(/not an array/);
  });
});
