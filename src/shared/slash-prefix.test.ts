import { describe, it, expect } from 'vitest';
import { parseSlashPrefix } from './slash-prefix';

describe('parseSlashPrefix', () => {
  it('parses simple slash command', () => {
    expect(parseSlashPrefix('/help')).toEqual({ cmd: 'help', args: '' });
  });

  it('parses slash command with args', () => {
    expect(parseSlashPrefix('/model claude-sonnet')).toEqual({
      cmd: 'model', args: 'claude-sonnet',
    });
  });

  it('preserves multi-word args (trimmed)', () => {
    expect(parseSlashPrefix('/foo  arg1 arg2  ')).toEqual({
      cmd: 'foo', args: 'arg1 arg2',
    });
  });

  it('returns null for non-slash text', () => {
    expect(parseSlashPrefix('hello world')).toBeNull();
    expect(parseSlashPrefix('foo /bar')).toBeNull();
  });

  it('returns null for multi-line input even if it starts with slash', () => {
    // Regression: quoted snippet that happens to start with `/` should NOT
    // be treated as a slash command.
    expect(parseSlashPrefix('/cmd\nmore text')).toBeNull();
    expect(parseSlashPrefix('/help\n')).toBeNull();
  });

  it('returns null for bare slash with no command name', () => {
    expect(parseSlashPrefix('/')).toBeNull();
    expect(parseSlashPrefix('/ args')).toBeNull();
  });

  it('handles underscores and digits in cmd name', () => {
    expect(parseSlashPrefix('/my_cmd2 x')).toEqual({ cmd: 'my_cmd2', args: 'x' });
  });
});
