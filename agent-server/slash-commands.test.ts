import { describe, it, expect } from 'vitest';
import { createClaudeBackend } from './providers/claude';
import { createCopilotBackend } from './providers/copilot';

describe('Claude handleSlashCommand', () => {
  it('always returns pass-through (SDK handles natively)', async () => {
    const backend = createClaudeBackend();
    expect(backend.handleSlashCommand).toBeDefined();
    const cases = [
      ['compact', ''],
      ['clear', ''],
      ['model', 'sonnet'],
      ['unknown', 'foo'],
    ];
    for (const [cmd, args] of cases) {
      const result = await backend.handleSlashCommand!(cmd, args);
      expect(result).toEqual({ type: 'pass-through' });
    }
    backend.dispose();
  });
});

describe('Copilot handleSlashCommand', () => {
  it('/clear resets context and returns context-cleared', async () => {
    const backend = createCopilotBackend();
    const result = await backend.handleSlashCommand!('clear', '');
    expect(result.type).toBe('context-cleared');
    backend.dispose();
  });

  it('/help lists available commands', async () => {
    const backend = createCopilotBackend();
    const result = await backend.handleSlashCommand!('help', '');
    expect(result.type).toBe('system-message');
    if (result.type === 'system-message') {
      expect(result.content).toContain('/model');
      expect(result.content).toContain('/clear');
      expect(result.content).toContain('/compact');
      expect(result.content).toContain('/context');
      expect(result.content).toContain('/help');
    }
    backend.dispose();
  });

  it('/context shows token usage with default values', async () => {
    const backend = createCopilotBackend();
    const result = await backend.handleSlashCommand!('context', '');
    expect(result.type).toBe('system-message');
    if (result.type === 'system-message') {
      expect(result.content).toMatch(/Token usage:/);
      expect(result.content).toMatch(/Model:/);
    }
    backend.dispose();
  });

  it('/compact on empty history returns no-op system message', async () => {
    const backend = createCopilotBackend();
    const result = await backend.handleSlashCommand!('compact', '');
    expect(result.type).toBe('system-message');
    if (result.type === 'system-message') {
      expect(result.content).toMatch(/no history/i);
    }
    backend.dispose();
  });

  it('unknown command returns error', async () => {
    const backend = createCopilotBackend();
    const result = await backend.handleSlashCommand!('foobar', '');
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.message).toContain('foobar');
    }
    backend.dispose();
  });
});
