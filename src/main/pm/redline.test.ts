import { describe, it, expect, beforeEach } from 'vitest';
import * as scrollback from './scrollback-buffer';
import { checkRedline } from './redline';

beforeEach(() => {
  scrollback.clear();
});

describe('checkRedline', () => {
  it('blocks rm -rf', () => {
    scrollback.append('t1', 'Are you sure?\nrm -rf /var/data\n');
    expect(checkRedline('t1').blocked).toBe(true);
  });

  it('blocks git push --force', () => {
    scrollback.append('t1', 'git push --force origin main\n');
    expect(checkRedline('t1').blocked).toBe(true);
  });

  it('blocks git push -f', () => {
    scrollback.append('t1', 'git push -f origin main\n');
    expect(checkRedline('t1').blocked).toBe(true);
  });

  it('blocks DROP TABLE', () => {
    scrollback.append('t1', 'DROP TABLE users;\n');
    expect(checkRedline('t1').blocked).toBe(true);
  });

  it('blocks chmod 777', () => {
    scrollback.append('t1', 'chmod 777 /etc/passwd\n');
    expect(checkRedline('t1').blocked).toBe(true);
  });

  it('allows normal commands', () => {
    scrollback.append('t1', 'npm test\nAll tests passed\n');
    expect(checkRedline('t1').blocked).toBe(false);
  });

  it('allows normal git push', () => {
    scrollback.append('t1', 'git push origin feature-branch\n');
    expect(checkRedline('t1').blocked).toBe(false);
  });

  it('returns empty for unknown tab', () => {
    expect(checkRedline('nonexistent').blocked).toBe(false);
  });
});
