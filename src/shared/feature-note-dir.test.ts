import { describe, expect, it } from 'vitest';
import { normalizeFeatureNoteDir } from './feature-note-dir';

describe('normalizeFeatureNoteDir', () => {
  it('treats absent and blank values as disabled', () => {
    expect(normalizeFeatureNoteDir(undefined)).toBeUndefined();
    expect(normalizeFeatureNoteDir('   ')).toBeUndefined();
  });

  it('trims whitespace and trailing slashes', () => {
    expect(normalizeFeatureNoteDir('  .agent/features///  ')).toBe('.agent/features');
  });

  it.each([
    ['/absolute', 'relative'],
    ['.', 'current-directory'],
    ['./notes', 'current-directory'],
    ['notes/./drafts', 'current-directory'],
    ['../notes', 'parent'],
    ['notes/../drafts', 'parent'],
    ['notes//drafts', 'empty'],
    ['notes\\drafts', 'POSIX'],
  ])('rejects unsafe or non-canonical path %s', (value, expectedMessage) => {
    expect(() => normalizeFeatureNoteDir(value)).toThrow(expectedMessage);
  });
});
