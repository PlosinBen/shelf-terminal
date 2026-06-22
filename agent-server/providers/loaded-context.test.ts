import { describe, it, expect } from 'vitest';
import {
  normalizeClaudeMcpServers,
  normalizeClaudeCommandsAsSkills,
  normalizeCopilotSkillSource,
  normalizeCopilotSkills,
  normalizeCopilotMcpServers,
  formatMcpCard,
  formatSkillsCard,
} from './loaded-context';

describe('normalizeClaudeMcpServers', () => {
  it('maps name/status and keeps error only when present', () => {
    expect(normalizeClaudeMcpServers([
      { name: 'fs', status: 'connected' },
      { name: 'db', status: 'failed', error: 'ECONNREFUSED' },
    ])).toEqual([
      { name: 'fs', status: 'connected' },
      { name: 'db', status: 'failed', error: 'ECONNREFUSED' },
    ]);
  });
});

describe('normalizeClaudeCommandsAsSkills', () => {
  it('drops known built-ins, keeps the rest (no source)', () => {
    const builtins = new Set(['clear', 'compact', 'context', 'usage', 'mcp', 'skills']);
    expect(normalizeClaudeCommandsAsSkills([
      { name: 'clear', description: 'reset' },
      { name: 'review', description: 'do a review' },
      { name: 'deploy' },
    ], builtins)).toEqual([
      { name: 'review', description: 'do a review' },
      { name: 'deploy' },
    ]);
  });
});

describe('normalizeCopilotSkillSource', () => {
  it('buckets copilot SkillSource into project/app/personal/other', () => {
    expect(normalizeCopilotSkillSource('project')).toBe('project');
    expect(normalizeCopilotSkillSource('inherited')).toBe('project');
    expect(normalizeCopilotSkillSource('custom')).toBe('app');
    expect(normalizeCopilotSkillSource('personal-copilot')).toBe('personal');
    expect(normalizeCopilotSkillSource('personal-claude')).toBe('personal');
    expect(normalizeCopilotSkillSource('plugin')).toBe('other');
    expect(normalizeCopilotSkillSource('builtin')).toBe('other');
    expect(normalizeCopilotSkillSource(undefined)).toBeUndefined();
  });
});

describe('normalizeCopilotSkills', () => {
  it('carries description/source/enabled when present', () => {
    expect(normalizeCopilotSkills([
      { name: 'a', description: 'does a', source: 'project', enabled: true },
      { name: 'b', source: 'custom', enabled: false },
      { name: 'c' },
    ])).toEqual([
      { name: 'a', description: 'does a', source: 'project', enabled: true },
      { name: 'b', source: 'app', enabled: false },
      { name: 'c' },
    ]);
  });
});

describe('normalizeCopilotMcpServers', () => {
  it('defaults status to unknown and keeps error/source', () => {
    expect(normalizeCopilotMcpServers([
      { name: 'x', status: 'connected', source: 'project' },
      { name: 'y', error: 'boom' },
    ])).toEqual([
      { name: 'x', status: 'connected', source: 'project' },
      { name: 'y', status: 'unknown', error: 'boom' },
    ]);
  });
});

describe('formatMcpCard', () => {
  it('explicit none line when empty (never blank)', () => {
    expect(formatMcpCard([])).toBe('No MCP servers loaded in this session.');
  });
  it('lists servers with status, error, source', () => {
    const out = formatMcpCard([
      { name: 'fs', status: 'connected' },
      { name: 'db', status: 'failed', error: 'ECONNREFUSED', source: 'project' },
    ]);
    expect(out).toContain('2 MCP servers:');
    expect(out).toContain('- **fs** — connected');
    expect(out).toContain('- **db** — failed (ECONNREFUSED) · project');
  });
});

describe('formatSkillsCard', () => {
  it('explicit none line when empty', () => {
    expect(formatSkillsCard([])).toBe('No skills loaded in this session.');
  });
  it('lists skills with source/disabled/description', () => {
    const out = formatSkillsCard([
      { name: 'review', description: 'do a review', source: 'app', enabled: true },
      { name: 'old', source: 'personal', enabled: false },
      { name: 'bare' },
    ]);
    expect(out).toContain('3 skills:');
    expect(out).toContain('- **review** · app — do a review');
    expect(out).toContain('- **old** · personal (disabled)');
    expect(out).toContain('- **bare**');
  });
});
