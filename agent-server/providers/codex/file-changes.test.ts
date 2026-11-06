import { describe, expect, it } from 'vitest';
import { fileChangesToMessages, parseFileChangeDiff } from './file-changes';

const patch = '@@ -2,2 +2,3 @@\n-before\n+after\n+inserted\n context\n@@ -10 +11 @@\n-old\n+new\n';
const update = (path = 'a.ts', diff = patch) => ({ path, kind: { type: 'update' }, diff });
const convert = (changes: unknown, status = 'completed', id = 'item-1') => fileChangesToMessages(id, { changes, status });

describe('parseFileChangeDiff', () => {
  it('retains separated hunks and offsets after inserted lines', () => {
    expect(parseFileChangeDiff(patch)).toEqual({ ok: true, hunks: [
      { oldStart: 2, newStart: 2, oldLines: ['before', 'context'], newLines: ['after', 'inserted', 'context'] },
      { oldStart: 10, newStart: 11, oldLines: ['old'], newLines: ['new'] },
    ] });
  });

  it('distinguishes file headers from header-like hunk content and preserves blank lines', () => {
    expect(parseFileChangeDiff('--- a\n+++ a\n@@ -1,3 +1,3 @@ function\n--- content\n+++ content\n \n trailing \n')).toEqual({ ok: true, hunks: [
      { oldStart: 1, newStart: 1, oldLines: ['-- content', '', 'trailing '], newLines: ['++ content', '', 'trailing '] },
    ] });
  });

  it.each([
    ['@@ -0,0 +1 @@\n+\n', [], ['']],
    ['@@ -1 +0,0 @@\n-\n', [''], []],
  ])('preserves zero lines versus one blank line: %s', (diff, oldLines, newLines) => {
    expect(parseFileChangeDiff(diff as string)).toMatchObject({ ok: true, hunks: [{ oldLines, newLines }] });
  });

  it('accepts adjacent hunks without joining them', () => {
    expect(parseFileChangeDiff('@@ -1 +1 @@\n-a\n+b\n@@ -2 +2 @@\n-c\n+d')).toMatchObject({ ok: true, hunks: [{ oldStart: 1 }, { oldStart: 2 }] });
  });

  it.each([
    ['CRLF', '@@ -1 +1 @@\r\n-a\r\n+b\r\n'],
    ['EOF marker', '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n'],
    ['wrong count', '@@ -1,2 +1 @@\n-a\n+b\n'],
    ['extra line', '@@ -1 +1 @@\n-a\n+b\n+lost'],
    ['unknown line', '@@ -1 +1 @@\n-a\n+b\nunknown'],
    ['raw content', 'not a patch'],
    ['partial header', '@@ function\n-a\n+b'],
    ['zero start with content', '@@ -0 +0 @@\n-a\n+b'],
    ['unsafe number', '@@ -9007199254740992 +1 @@\n-a\n+b'],
    ['unchanged', '@@ -1 +1 @@\n same'],
    ['overlap', '@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-c\n+d'],
    ['inconsistent gap', '@@ -1 +1 @@\n-a\n+b\n@@ -5 +6 @@\n-c\n+d'],
    ['invalid second hunk', '@@ -1 +1 @@\n-a\n+b\n@@ -5,2 +5 @@\n-c\n+d'],
    ['empty diff', ''],
  ])('rejects %s without returning a partial diff', (_name, diff) => {
    expect(parseFileChangeDiff(diff)).toMatchObject({ ok: false });
    expect(parseFileChangeDiff(diff)).not.toHaveProperty('hunks');
  });
});

describe('fileChangesToMessages', () => {
  it('uses stable per-path IDs across status, order and body-kind changes', () => {
    const first = convert([update(), update('b.ts')], 'inProgress').messages;
    const second = convert([update('b.ts'), update('a.ts', 'invalid')], 'completed').messages;
    expect(second.map(m => 'msgId' in m && m.msgId)).toEqual(first.map(m => 'msgId' in m && m.msgId).reverse());
    expect(convert([update()], 'completed', 'another-item').messages[0]).not.toMatchObject({ msgId: (first[0] as any).msgId });
    expect(convert([update()], 'inProgress').messages[0]).toEqual(first[0]);
    expect(JSON.stringify(first.map(m => 'msgId' in m && m.msgId))).not.toContain('a.ts');
  });

  it('independently renders supported edits and lossless fallback content', () => {
    const raw = '```\n```\n';
    const { messages, diagnostics } = convert([
      update(), { path: 'new.md', kind: { type: 'add' }, diff: raw },
      { path: 'gone.ts', kind: { type: 'delete' }, diff: '  \n' },
      { path: 'move.ts', kind: { type: 'update', move_path: 'dest.ts' }, diff: patch },
    ]);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({ msgType: 'fold_diff' });
    expect(messages.slice(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ subtitle: 'new.md', body: { content: expect.stringContaining('````diff\n' + raw + '\n````') } }),
      expect.objectContaining({ subtitle: 'gone.ts', body: { content: expect.stringContaining('```diff\n  \n\n```') } }),
      expect.objectContaining({ subtitle: 'move.ts', body: { content: expect.stringContaining('dest.ts') } }),
    ]));
    expect(diagnostics.every(d => d.level === 'debug')).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain('before');
  });

  it.each(['failed', 'declined'])('carries %s to every file', status => {
    const { messages } = convert([update(), { path: 'b', kind: { type: 'add' }, diff: 'content' }], status);
    for (const message of messages) expect(message).toMatchObject({ errorMessage: `File change ${status}` });
  });

  it.each([[], null, 'malformed'])('makes empty or invalid changes visible: %j', changes => {
    const out = convert(changes);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({ msgType: 'fold_markdown', body: { content: expect.any(String) } });
    expect(out.diagnostics).toHaveLength(1);
  });

  it('preserves malformed entries and duplicate paths without overwriting a card', () => {
    const out = convert([null, { diff: 'path missing' }, update(), { ...update(), diff: 'duplicate content' },
      { path: 'unknown', kind: { type: 'future' }, diff: 'unknown content' },
      { path: 'bad-diff', kind: { type: 'update' }, diff: 42 }]);
    expect(out.messages).toHaveLength(5);
    expect(new Set(out.messages.map(m => 'msgId' in m && m.msgId)).size).toBe(5);
    expect(JSON.stringify(out.messages)).toContain('duplicate content');
    expect(JSON.stringify(out.messages)).toContain('unknown content');
    expect(out.diagnostics.every(d => d.level === 'warn')).toBe(true);
  });
});
