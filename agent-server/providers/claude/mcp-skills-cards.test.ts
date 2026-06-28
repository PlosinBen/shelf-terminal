import { describe, it, expect } from 'vitest';
import { formatClaudeMcpCard, formatClaudeSkillsCard } from './helpers';

const BUILTINS = new Set(['clear', 'compact', 'mcp', 'skills', 'model']);

describe('formatClaudeMcpCard', () => {
  it('renders a servers table and a flat tools table (with annotations)', () => {
    const md = formatClaudeMcpCard([
      {
        name: 'shelf',
        status: 'connected',
        tools: [
          { name: 'list_app_skills', description: 'list skills', annotations: { readOnly: true } },
          { name: 'update_app_skill', description: 'edit a skill', annotations: { destructive: true } },
        ],
      },
    ]);
    expect(md).toContain('1 MCP server:');
    expect(md).toContain('| Server | Status |');
    expect(md).toContain('| `shelf` | connected |');
    expect(md).toContain('2 MCP tools:');
    expect(md).toContain('| Tool | Server | Description |');
    expect(md).toContain('| `list_app_skills` _(read-only)_ | `shelf` | list skills |');
    expect(md).toContain('_(destructive)_');
  });

  it('a server with no tools → servers table only, no tools table', () => {
    const md = formatClaudeMcpCard([{ name: 'empty', status: 'connected' }]);
    expect(md).toContain('| `empty` | connected |');
    expect(md).not.toContain('MCP tool');
  });

  it('folds a failed server error into the status cell', () => {
    const md = formatClaudeMcpCard([{ name: 'broken', status: 'failed', error: 'spawn ENOENT' }]);
    expect(md).toContain('| `broken` | failed (spawn ENOENT) |');
  });

  it('empty server set → explicit none line, never blank', () => {
    expect(formatClaudeMcpCard([])).toBe('No MCP servers loaded in this session.');
  });
});

describe('formatClaudeSkillsCard', () => {
  it('lists user skills and filters built-in commands', () => {
    const md = formatClaudeSkillsCard(
      [{ name: 'my-skill', description: 'does a thing' }, { name: 'clear' }, { name: 'mcp' }],
      BUILTINS,
    );
    expect(md).toContain('1 skill:');
    expect(md).toContain('`my-skill` — does a thing');
    expect(md).not.toContain('clear');
    expect(md).not.toContain('`mcp`');
  });

  it('all-builtin → explicit none line', () => {
    expect(formatClaudeSkillsCard([{ name: 'clear' }, { name: 'compact' }], BUILTINS))
      .toBe('No skills loaded in this session.');
  });
});
