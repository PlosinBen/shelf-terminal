import { describe, it, expect } from 'vitest';
import { mapAgentState } from './tab-watcher';

describe('mapAgentState', () => {
  it('maps idle to idle_shell', () => {
    expect(mapAgentState('idle')).toBe('idle_shell');
  });

  it('maps streaming to cli_running', () => {
    expect(mapAgentState('streaming')).toBe('cli_running');
  });

  it('maps waiting_permission to cli_waiting_permission', () => {
    expect(mapAgentState('waiting_permission')).toBe('cli_waiting_permission');
  });

  it('maps error to cli_error', () => {
    expect(mapAgentState('error')).toBe('cli_error');
  });
});
