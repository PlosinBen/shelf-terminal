import { describe, it, expect, vi } from 'vitest';

vi.mock('../skills-store', () => ({
  listSkills: async () => [
    { name: 'alpha', description: 'first skill' },
    { name: 'beta' },
  ],
}));
vi.mock('../mcp-store', () => ({
  listMcpServers: () => ({
    playwright: { type: 'http', url: 'https://x' },
    fs: { type: 'stdio', command: 'node' },
  }),
}));

const { enumerateLiveItems } = await import('./enumerate');

describe('config-backup enumerate live items', () => {
  it('lists skills (by name) then MCP servers (by name), with ids + detail', async () => {
    const items = await enumerateLiveItems();
    expect(items).toEqual([
      { id: 'skill:alpha', kind: 'skill', name: 'alpha', detail: 'first skill' },
      { id: 'skill:beta', kind: 'skill', name: 'beta' },
      { id: 'mcp:fs', kind: 'mcp', name: 'fs', detail: 'stdio' },
      { id: 'mcp:playwright', kind: 'mcp', name: 'playwright', detail: 'http' },
    ]);
  });
});
