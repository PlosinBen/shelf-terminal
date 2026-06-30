import { describe, it, expect } from 'vitest';
import { resolveVarRefs, resolveServerVars, parseMcpConfig } from './mcp-config';
import type { McpServerBlock } from '@shared/mcp';

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
    const b: McpServerBlock = { type: 'stdio', command: 'node', env: { TOKEN: '${T}' } };
    const out = resolveServerVars(b, { T: 'secret' });
    expect(out.missing).toEqual([]);
    expect((out.block as any).env).toEqual({ TOKEN: 'secret' });
  });
  it('resolves http header refs and collects missing', () => {
    const b: McpServerBlock = { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer ${K}' } };
    const out = resolveServerVars(b, {});
    expect(out.missing).toEqual(['K']);
  });
});

describe('parseMcpConfig (keyed object, fail-loud)', () => {
  const env = { TOKEN: 'tok' };

  it('parses + resolves valid servers into a name→block record', () => {
    const raw = JSON.stringify({
      gh: { type: 'stdio', command: 'node', env: { GITHUB_TOKEN: '${TOKEN}' } },
      api: { type: 'http', url: 'https://x' },
    });
    const out = parseMcpConfig(raw, env);
    expect(out.errors).toEqual([]);
    expect(Object.keys(out.servers)).toEqual(['gh', 'api']);
    expect((out.servers.gh as any).env).toEqual({ GITHUB_TOKEN: 'tok' });
  });

  it('drops a server with a missing env ref AND records an error (never silent)', () => {
    const raw = JSON.stringify({
      gh: { type: 'stdio', command: 'node', env: { T: '${ABSENT}' } },
      ok: { type: 'http', url: 'https://x' },
    });
    const out = parseMcpConfig(raw, env);
    expect(Object.keys(out.servers)).toEqual(['ok']);
    expect(out.errors.join(' ')).toMatch(/gh.*ABSENT/);
  });

  it('drops an invalid-shape / bad-name entry with an error', () => {
    expect(parseMcpConfig(JSON.stringify({ x: { type: 'stdio' } }), env).errors[0]).toMatch(/invalid MCP server/i);
    expect(parseMcpConfig(JSON.stringify({ 'bad name': { type: 'stdio', command: 'x' } }), env).errors[0]).toMatch(/invalid MCP server/i);
  });

  it('bad JSON / non-object → empty + a loud error', () => {
    expect(parseMcpConfig('{ not json', env).errors[0]).toMatch(/not valid JSON/);
    expect(parseMcpConfig('[1,2]', env).errors[0]).toMatch(/not a keyed object/);
  });
});
