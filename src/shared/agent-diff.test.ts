import { describe, expect, it } from 'vitest';
import { readAgentDiff } from './agent-diff';

const first = { oldStart: 2, newStart: 2, oldLines: ['a'], newLines: ['b', 'c'] };
const second = { oldStart: 10, newStart: 11, oldLines: ['x'], newLines: ['y'] };

describe('readAgentDiff', () => {
  it('preserves legacy snippets including newline characters', () => {
    const diff = { oldString: 'a\nb\n', newString: 'c\n' };
    expect(readAgentDiff(diff)).toEqual({ ok: true, diff });
  });
  it('preserves all hunk positions and line contents', () => {
    expect(readAgentDiff({ hunks: [first, second] })).toEqual({ ok: true, diff: { hunks: [first, second] } });
  });
  it('represents an empty side without inventing a blank line', () => {
    expect(readAgentDiff({ hunks: [{ oldStart: 0, newStart: 1, oldLines: [], newLines: [''] }] })).toMatchObject({ ok: true });
  });
  it.each([
    null, {}, { oldString: 'a' }, { hunks: [] }, { hunks: [first], oldString: 'a', newString: 'b' },
    { hunks: [first, { ...second, oldLines: [4] }] },
    { hunks: [{ ...first, oldStart: -1 }] }, { hunks: [{ ...first, newStart: 1.5 }] },
    { hunks: [{ ...first, oldStart: Number.MAX_SAFE_INTEGER + 1 }] },
    { hunks: [{ ...first, oldLines: ['a\nb'] }] }, { hunks: [{ ...first, newLines: ['b\r'] }] },
    { hunks: [first, { ...second, oldStart: 2 }] },
    { hunks: [first, { ...second, newStart: 10 }] },
    { hunks: [{ ...first, oldLines: [], newLines: [] }] },
  ])('rejects malformed bodies as a whole: %j', value => {
    expect(readAgentDiff(value)).toMatchObject({ ok: false, reason: expect.any(String) });
  });
});
