import { describe, expect, it } from 'vitest';
import { normalizeWorktreePrefillNotePaths } from './worktree-prefill';

describe('normalizeWorktreePrefillNotePaths', () => {
  it('treats absent or empty proposal notes as no prefill', () => {
    expect(normalizeWorktreePrefillNotePaths(undefined)).toEqual([]);
    expect(normalizeWorktreePrefillNotePaths(['', '   '])).toEqual([]);
  });

  it('trims and dedupes proposed note paths while preserving order', () => {
    expect(normalizeWorktreePrefillNotePaths([
      ' .agent/features/a.md ',
      '.agent/features/b.md',
      '.agent/features/a.md',
    ])).toEqual(['.agent/features/a.md', '.agent/features/b.md']);
  });
});
