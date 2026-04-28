import { describe, it, expect } from 'vitest';
import { inferTabState } from './tools';

describe('inferTabState', () => {
  it('returns idle_shell for empty text', () => {
    expect(inferTabState('')).toBe('idle_shell');
  });

  it('returns idle_shell for shell prompt', () => {
    expect(inferTabState('user@host:~/project$ ')).toBe('idle_shell');
    expect(inferTabState('% ')).toBe('idle_shell');
    expect(inferTabState('# ')).toBe('idle_shell');
  });

  it('returns cli_waiting_permission for permission prompts', () => {
    expect(inferTabState('Allow this action? (y/n)')).toBe('cli_waiting_permission');
    expect(inferTabState('Do you want to proceed?')).toBe('cli_waiting_permission');
    expect(inferTabState('Approve this change?')).toBe('cli_waiting_permission');
  });

  it('returns cli_error for error patterns', () => {
    expect(inferTabState('Error: file not found')).toBe('cli_error');
    expect(inferTabState('FAILED to compile')).toBe('cli_error');
    expect(inferTabState('panic: runtime error')).toBe('cli_error');
    expect(inferTabState('command not found: foo')).toBe('cli_error');
  });

  it('returns cli_done for completion patterns', () => {
    expect(inferTabState('Done in 3.2s\nReady for input')).toBe('cli_done');
    expect(inferTabState('Successfully completed')).toBe('cli_done');
  });

  it('returns cli_waiting_input for input prompts', () => {
    expect(inferTabState('What would you like to do?')).toBe('cli_waiting_input');
    expect(inferTabState('Enter your choice:')).toBe('cli_waiting_input');
  });

  it('returns cli_running for active output', () => {
    expect(inferTabState('Compiling src/main.ts...\nBuilding modules')).toBe('cli_running');
  });

  it('permission takes priority over error', () => {
    expect(inferTabState('Error occurred\nAllow retry? (y/n)')).toBe('cli_waiting_permission');
  });

  it('returns idle_shell for CLI agent idle prompt (❯)', () => {
    // Claude Code uses ❯ as its input prompt character
    expect(inferTabState('some response text\n❯ ')).toBe('idle_shell');
    expect(inferTabState('❯')).toBe('idle_shell');
  });

  it('returns idle_shell when ❯ is not the last line (TUI status bar below)', () => {
    // TUI-based CLIs render status bar below the prompt; after ANSI strip
    // the status bar text ends up as the last non-empty line
    const scrollback = [
      '────────────────────────────',
      '❯ ',
      '────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(inferTabState(scrollback)).toBe('idle_shell');
  });

  it('cli_done takes priority over ❯ prompt', () => {
    const scrollback = 'Successfully completed\n❯ ';
    expect(inferTabState(scrollback)).toBe('cli_done');
  });
});
