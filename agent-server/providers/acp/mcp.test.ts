import { describe, it, expect } from 'vitest';
import type { McpServersFile } from '@shared/mcp';
import { toAcpMcpServers } from './mcp';

describe('toAcpMcpServers', () => {
  it('maps a stdio server (env → [{name,value}], args default [])', () => {
    const servers: McpServersFile = {
      fs: { type: 'stdio', command: 'mcp-fs', args: ['--root', '/w'], env: { TOKEN: 'abc' } },
      bare: { type: 'stdio', command: 'x' },
    };
    expect(toAcpMcpServers(servers)).toEqual([
      { name: 'fs', command: 'mcp-fs', args: ['--root', '/w'], env: [{ name: 'TOKEN', value: 'abc' }] },
      { name: 'bare', command: 'x', args: [], env: [] },
    ]);
  });

  it('maps an http server (headers → [{name,value}], type tag preserved)', () => {
    const servers: McpServersFile = {
      api: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } },
    };
    expect(toAcpMcpServers(servers)).toEqual([
      { type: 'http', name: 'api', url: 'https://x/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] },
    ]);
  });

  it('maps an empty set to an empty list', () => {
    expect(toAcpMcpServers({})).toEqual([]);
  });
});
