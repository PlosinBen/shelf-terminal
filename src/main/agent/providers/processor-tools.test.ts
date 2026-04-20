import { describe, it, expect } from 'vitest';
import {
  TOOLS,
  toolsForMode,
  toOpenAIFormat,
  shouldAllowAutomatically,
  shouldDenyAutomatically,
  getEffortLevels,
  buildSystemPrompt,
  SLASH_COMMANDS,
} from './processor-tools';

describe('tool registry', () => {
  it('declares every expected tool', () => {
    expect(Object.keys(TOOLS).sort()).toEqual(
      ['Bash', 'Edit', 'Glob', 'Grep', 'Ls', 'Read', 'Write'].sort(),
    );
  });

  it('every tool has a category', () => {
    for (const tool of Object.values(TOOLS)) {
      expect(['read', 'exec', 'write']).toContain(tool.category);
    }
  });
});

describe('toolsForMode', () => {
  it('returns all tools for default mode', () => {
    expect(toolsForMode('default').length).toBe(Object.keys(TOOLS).length);
  });

  it('returns all tools for acceptEdits', () => {
    expect(toolsForMode('acceptEdits').length).toBe(Object.keys(TOOLS).length);
  });

  it('filters to read-only in plan mode', () => {
    const tools = toolsForMode('plan');
    expect(tools.every((t) => t.category === 'read')).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });
});

describe('toOpenAIFormat', () => {
  it('wraps tools with function schema', () => {
    const formatted = toOpenAIFormat([TOOLS.Read]);
    expect(formatted[0]).toMatchObject({
      type: 'function',
      function: { name: 'Read' },
    });
    expect(formatted[0].function.parameters).toBe(TOOLS.Read.parameters);
  });
});

describe('shouldAllowAutomatically', () => {
  it('bypass allows everything', () => {
    expect(shouldAllowAutomatically('bypassPermissions', 'read')).toBe(true);
    expect(shouldAllowAutomatically('bypassPermissions', 'exec')).toBe(true);
    expect(shouldAllowAutomatically('bypassPermissions', 'write')).toBe(true);
  });

  it('plan allows only read', () => {
    expect(shouldAllowAutomatically('plan', 'read')).toBe(true);
    expect(shouldAllowAutomatically('plan', 'exec')).toBe(false);
    expect(shouldAllowAutomatically('plan', 'write')).toBe(false);
  });

  it('acceptEdits auto-allows read and write, asks on exec', () => {
    expect(shouldAllowAutomatically('acceptEdits', 'read')).toBe(true);
    expect(shouldAllowAutomatically('acceptEdits', 'write')).toBe(true);
    expect(shouldAllowAutomatically('acceptEdits', 'exec')).toBe(false);
  });

  it('default asks on everything', () => {
    expect(shouldAllowAutomatically('default', 'read')).toBe(false);
    expect(shouldAllowAutomatically('default', 'exec')).toBe(false);
    expect(shouldAllowAutomatically('default', 'write')).toBe(false);
  });
});

describe('shouldDenyAutomatically', () => {
  it('plan denies exec and write', () => {
    expect(shouldDenyAutomatically('plan', 'exec')).toBe(true);
    expect(shouldDenyAutomatically('plan', 'write')).toBe(true);
    expect(shouldDenyAutomatically('plan', 'read')).toBe(false);
  });

  it('other modes deny nothing automatically', () => {
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions']) {
      expect(shouldDenyAutomatically(mode, 'read')).toBe(false);
      expect(shouldDenyAutomatically(mode, 'exec')).toBe(false);
      expect(shouldDenyAutomatically(mode, 'write')).toBe(false);
    }
  });
});

describe('getEffortLevels', () => {
  it('returns empty for non-reasoning models', () => {
    expect(getEffortLevels('gpt-4o')).toEqual([]);
    expect(getEffortLevels('claude-sonnet-4')).toEqual([]);
    expect(getEffortLevels('gpt-5-chat')).toEqual([]);
  });

  it('detects o-series reasoning models', () => {
    expect(getEffortLevels('o1')).toEqual(['low', 'medium', 'high']);
    expect(getEffortLevels('o3-mini')).toEqual(['low', 'medium', 'high']);
    expect(getEffortLevels('o4-mini')).toEqual(['low', 'medium', 'high']);
  });

  it('detects gpt-5 family with minimal tier (excluding gpt-5-chat)', () => {
    expect(getEffortLevels('gpt-5')).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(getEffortLevels('gpt-5-codex')).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(getEffortLevels('gpt-5-chat')).toEqual([]);
  });
});

describe('buildSystemPrompt', () => {
  it('mentions the cwd', () => {
    const p = buildSystemPrompt('/tmp/project', 'default');
    expect(p).toContain('/tmp/project');
  });

  it('injects plan-mode instructions', () => {
    const p = buildSystemPrompt('/x', 'plan');
    expect(p).toMatch(/PLAN MODE/);
    expect(p).toMatch(/Do NOT execute/);
  });

  it('injects acceptEdits guidance', () => {
    const p = buildSystemPrompt('/x', 'acceptEdits');
    expect(p).toMatch(/applied automatically/);
  });

  it('embeds project instructions when provided', () => {
    const p = buildSystemPrompt('/x', 'default', 'Use tabs not spaces.');
    expect(p).toContain('### Project instructions');
    expect(p).toContain('Use tabs not spaces.');
  });

  it('omits the instructions block when absent or blank', () => {
    expect(buildSystemPrompt('/x', 'default')).not.toContain('### Project instructions');
    expect(buildSystemPrompt('/x', 'default', '   ')).not.toContain('### Project instructions');
  });
});

describe('SLASH_COMMANDS', () => {
  it('every entry has name and description', () => {
    for (const c of SLASH_COMMANDS) {
      expect(c.name).toMatch(/^[a-z]+$/);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });
});
