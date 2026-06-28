import { describe, it, expect } from 'vitest';
import { formatCopilotMcpCard, formatCopilotSkillsCard } from './helpers';

describe('formatCopilotMcpCard', () => {
  it('renders a server table with adaptive Source column', () => {
    const md = formatCopilotMcpCard([
      { name: 'fs', status: 'connected', source: 'user' },
      { name: 'db', status: 'failed', error: 'down' },
    ]);
    expect(md).toContain('2 MCP servers:');
    expect(md).toContain('| Server | Status | Source |');
    expect(md).toContain('`fs`');
    expect(md).toContain('failed (down)');
  });

  it('drops the Source column when no server has a source', () => {
    const md = formatCopilotMcpCard([{ name: 'fs', status: 'connected' }]);
    expect(md).toContain('| Server | Status |');
    expect(md).not.toContain('Source');
  });

  it('empty → explicit none line', () => {
    expect(formatCopilotMcpCard([])).toBe('No MCP servers loaded in this session.');
  });
});

describe('formatCopilotSkillsCard', () => {
  it('maps source buckets and marks disabled skills', () => {
    const md = formatCopilotSkillsCard([
      { name: 'a', description: 'app skill', source: 'custom' },     // custom → app
      { name: 'b', source: 'inherited', enabled: false },            // inherited → project, disabled
    ]);
    expect(md).toContain('2 skills:');
    expect(md).toContain('`a`');
    expect(md).toContain('app');      // custom → app bucket
    expect(md).toContain('project');  // inherited → project bucket
    expect(md).toContain('(disabled)');
  });

  it('drops Source/Description columns when absent on every row', () => {
    const md = formatCopilotSkillsCard([{ name: 'bare' }]);
    expect(md).toContain('| Skill |');
    expect(md).not.toContain('Source');
    expect(md).not.toContain('Description');
  });

  it('empty → explicit none line', () => {
    expect(formatCopilotSkillsCard([])).toBe('No skills loaded in this session.');
  });
});
