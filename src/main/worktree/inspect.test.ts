import { describe, it, expect } from 'vitest';
import { parseWorktreeList } from './inspect';

const oid = 'a'.repeat(40);
const record = (...fields: string[]) => fields.join('\0') + '\0\0';
describe('worktree porcelain parsing', () => {
  it('preserves special paths and includes detached and locked records', () => {
    expect(parseWorktreeList(record('worktree /a\nb ', `HEAD ${oid}`, 'branch refs/heads/main') + record('worktree /detached', `HEAD ${oid}`, 'detached', 'locked reason', 'future optional'))).toEqual([
      { path: '/a\nb ', head: oid, branch: 'main', bare: false },
      { path: '/detached', head: oid, branch: null, bare: false },
    ]);
  });
  it('accepts bare records and prunable registrations', () => {
    expect(parseWorktreeList(record('worktree /bare', 'bare') + record('worktree /gone', `HEAD ${oid}`, 'detached', 'prunable gone'))).toHaveLength(2);
  });
  it.each([
    '', 'worktree /a\0', record(`HEAD ${oid}`, 'detached'),
    record('worktree /a', `HEAD ${oid}`, 'detached', 'branch refs/heads/a'),
    record('worktree /a', 'HEAD garbage', 'detached'),
    record('worktree /a', `HEAD ${oid}`),
    record('worktree /a', 'bare') + record('worktree /a', 'bare'),
  ])('rejects incomplete or contradictory data %j', (input) => {
    expect(() => parseWorktreeList(input)).toThrow();
  });
});
