import { describe, it, expect, vi } from 'vitest';

vi.mock('../skills-store', () => ({
  listSkills: async () => [
    { name: 'alpha', description: 'first skill' },
    { name: 'beta' },
  ],
  skillDirPath: (name: string) => `/skills/${name}`,
}));
vi.mock('../mcp-store', () => ({
  listMcpServers: () => ({
    playwright: { type: 'http', url: 'https://x' },
    fs: { type: 'stdio', command: 'node' },
  }),
}));
vi.mock('./validation', () => ({
  validateSkillPayload: (name: string) => name === 'beta'
    ? { valid: false, reason: 'SKILL.md is invalid' }
    : { valid: true, payloadFiles: ['SKILL.md'] },
}));

const { enumerateLiveItems } = await import('./enumerate');

describe('config-backup enumerate live items', () => {
  it('lists skills (by name) then MCP servers (by name), with ids + detail', async () => {
    const items = await enumerateLiveItems();
    expect(items).toEqual([
      { id: 'skill:alpha', kind: 'skill', name: 'alpha', detail: 'first skill', valid: true },
      { id: 'skill:beta', kind: 'skill', name: 'beta', valid: false, invalidReason: 'SKILL.md is invalid' },
      { id: 'mcp:fs', kind: 'mcp', name: 'fs', detail: 'stdio', valid: true },
      { id: 'mcp:playwright', kind: 'mcp', name: 'playwright', detail: 'http', valid: true },
    ]);
  });

  // Backup uses an ALLOWLIST (only enumerated skill/mcp ids can be selected +
  // copied to the git remote). Project SECRET env vars are a userData side-car
  // that must NEVER become syncable — this locks the invariant so adding a new
  // enumerated kind is a conscious decision, not an accidental secret leak.
  it('never enumerates any kind beyond skill/mcp (secrets stay unsyncable)', async () => {
    const kinds = new Set((await enumerateLiveItems()).map((i) => i.kind));
    expect([...kinds].sort()).toEqual(['mcp', 'skill']);
  });
});
