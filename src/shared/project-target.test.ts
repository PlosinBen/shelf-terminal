import { describe, expect, it } from 'vitest';
import type { Connection } from './types';
import {
  normalizeProjectCwd,
  projectTargetKey,
  sameProjectTarget,
} from './project-target';

describe('project target identity', () => {
  it.each([
    ['/repo/project///', '/repo/project'],
    ['C:\\repo\\project\\\\', 'C:\\repo\\project'],
    ['/', '/'],
    ['C:\\', 'C:\\'],
    ['\\\\server\\share\\', '\\\\server\\share\\'],
  ])('normalizes trailing separators in %s while preserving roots', (cwd, expected) => {
    expect(normalizeProjectCwd(cwd)).toBe(expected);
  });

  it('ignores SSH credentials and idle policy', () => {
    const first: Connection = {
      type: 'ssh',
      host: 'example.com',
      port: 22,
      user: 'ben',
      password: 'first',
      idleShutdownMinutes: 5,
    };
    const second: Connection = {
      type: 'ssh',
      host: 'example.com',
      port: 22,
      user: 'ben',
      password: 'second',
      idleShutdownMinutes: 0,
    };

    expect(sameProjectTarget(
      { connection: first, cwd: '/repo/project/' },
      { connection: second, cwd: '/repo/project' },
    )).toBe(true);
  });

  it.each([
    [{ type: 'local' }, { type: 'ssh', host: 'localhost', port: 22, user: 'ben' }],
    [
      { type: 'ssh', host: 'one.example', port: 22, user: 'ben' },
      { type: 'ssh', host: 'two.example', port: 22, user: 'ben' },
    ],
    [{ type: 'wsl', distro: 'Ubuntu' }, { type: 'wsl', distro: 'Debian' }],
    [{ type: 'docker', container: 'one' }, { type: 'docker', container: 'two' }],
  ] satisfies [Connection, Connection][])('keeps distinct connection targets separate', (first, second) => {
    expect(sameProjectTarget(
      { connection: first, cwd: '/repo/project' },
      { connection: second, cwd: '/repo/project' },
    )).toBe(false);
  });

  it('uses collision-safe structured keys', () => {
    const first = projectTargetKey({
      connection: { type: 'ssh', host: 'bc', port: 22, user: 'a' },
      cwd: '/repo',
    });
    const second = projectTargetKey({
      connection: { type: 'ssh', host: 'c', port: 22, user: 'ab' },
      cwd: '/repo',
    });

    expect(first).not.toBe(second);
  });

  it('fails loudly for an unmodelled connection type', () => {
    expect(() => projectTargetKey({
      connection: { type: 'future' } as unknown as Connection,
      cwd: '/repo',
    })).toThrow('unmodelled project connection type: future');
  });
});
