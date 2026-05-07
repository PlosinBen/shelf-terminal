import { describe, it, expect } from 'vitest';
import { alignLineDiff } from './line-diff';

describe('alignLineDiff', () => {
  it('returns all-same rows for identical inputs', () => {
    const rows = alignLineDiff(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(rows.map((r) => r.kind)).toEqual(['same', 'same', 'same']);
  });

  it('marks pure additions', () => {
    const rows = alignLineDiff([], ['a', 'b']);
    expect(rows).toEqual([
      { kind: 'add', old: null, new: 'a' },
      { kind: 'add', old: null, new: 'b' },
    ]);
  });

  it('marks pure deletions', () => {
    const rows = alignLineDiff(['a', 'b'], []);
    expect(rows).toEqual([
      { kind: 'del', old: 'a', new: null },
      { kind: 'del', old: 'b', new: null },
    ]);
  });

  it('pairs adjacent del+add into change rows', () => {
    const rows = alignLineDiff(['x'], ['y']);
    expect(rows).toEqual([{ kind: 'change', old: 'x', new: 'y' }]);
  });

  it('keeps surrounding context as same rows', () => {
    const rows = alignLineDiff(
      ['a', 'old', 'c'],
      ['a', 'new', 'c'],
    );
    expect(rows).toEqual([
      { kind: 'same', old: 'a', new: 'a' },
      { kind: 'change', old: 'old', new: 'new' },
      { kind: 'same', old: 'c', new: 'c' },
    ]);
  });

  it('handles unequal del+add counts (extra removal stays del)', () => {
    const rows = alignLineDiff(['a', 'b', 'c'], ['x']);
    // LCS empty; backtrack yields [del a, del b, del c, add x]; pairing
    // collapses the trailing del+add into change(c → x).
    expect(rows).toEqual([
      { kind: 'del', old: 'a', new: null },
      { kind: 'del', old: 'b', new: null },
      { kind: 'change', old: 'c', new: 'x' },
    ]);
  });

  it('mixes additions before context and changes after', () => {
    const rows = alignLineDiff(
      ['fn() {', '  return 1;', '}'],
      ['fn() {', '  log();', '  return 2;', '}'],
    );
    // Common: 'fn() {' and '}'. Middle: del 'return 1;', add 'log();', add 'return 2;'.
    // After pair: change(return 1; → log();), add return 2;
    expect(rows).toEqual([
      { kind: 'same', old: 'fn() {', new: 'fn() {' },
      { kind: 'change', old: '  return 1;', new: '  log();' },
      { kind: 'add', old: null, new: '  return 2;' },
      { kind: 'same', old: '}', new: '}' },
    ]);
  });
});
