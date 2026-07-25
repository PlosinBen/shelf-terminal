import { describe, it, expect } from 'vitest';
import { parseFeatureNoteList } from './feature-notes';

/** Build the shell-dump shape parseFeatureNoteList consumes. */
function dump(entries: { path: string; body: string }[]): string {
  return entries.map((e) => `===SHELF_NOTE:${e.path}===\n${e.body}`).join('\n');
}

const inProgress = (title: string) =>
  `---\ntype: feature\ntitle: ${title}\nstatus: in-progress\n---\n\n# ${title}\n`;

describe('parseFeatureNoteList', () => {
  it('returns in-progress notes with their title and relative path', () => {
    const raw = dump([
      { path: '.agent/features/alpha.md', body: inProgress('Alpha Feature') },
    ]);
    expect(parseFeatureNoteList(raw)).toEqual([
      { path: '.agent/features/alpha.md', title: 'Alpha Feature' },
    ]);
  });

  it('drops notes that are not in-progress (cancelled)', () => {
    const raw = dump([
      { path: '.agent/features/done.md', body: '---\ntype: feature\ntitle: Done\nstatus: cancelled\n---\n' },
      { path: '.agent/features/live.md', body: inProgress('Live') },
    ]);
    expect(parseFeatureNoteList(raw)).toEqual([{ path: '.agent/features/live.md', title: 'Live' }]);
  });

  it('drops notes with no / malformed frontmatter', () => {
    const raw = dump([
      { path: '.agent/features/plain.md', body: '# Just a heading, no frontmatter\n' },
      { path: '.agent/features/nofence.md', body: 'type: feature\nstatus: in-progress\n' },
      { path: '.agent/features/ok.md', body: inProgress('Ok') },
    ]);
    expect(parseFeatureNoteList(raw)).toEqual([{ path: '.agent/features/ok.md', title: 'Ok' }]);
  });

  it('strips quotes around a quoted title', () => {
    const raw = dump([
      { path: '.agent/features/q.md', body: '---\ntype: feature\ntitle: "Quoted: Title"\nstatus: in-progress\n---\n' },
    ]);
    expect(parseFeatureNoteList(raw)).toEqual([{ path: '.agent/features/q.md', title: 'Quoted: Title' }]);
  });

  it('omits title when frontmatter has none', () => {
    const raw = dump([
      { path: '.agent/features/notitle.md', body: '---\ntype: feature\nstatus: in-progress\n---\n' },
    ]);
    expect(parseFeatureNoteList(raw)).toEqual([{ path: '.agent/features/notitle.md' }]);
  });

  it('returns [] for empty output (no feature notes)', () => {
    expect(parseFeatureNoteList('')).toEqual([]);
  });

  it('tolerates leading blank lines before the frontmatter fence', () => {
    const raw = dump([
      { path: '.agent/features/pad.md', body: '\n\n---\ntype: feature\ntitle: Padded\nstatus: in-progress\n---\n' },
    ]);
    expect(parseFeatureNoteList(raw)).toEqual([{ path: '.agent/features/pad.md', title: 'Padded' }]);
  });

  it('keeps multiple in-progress notes in dump order', () => {
    const raw = dump([
      { path: '.agent/features/a.md', body: inProgress('A') },
      { path: '.agent/features/b.md', body: inProgress('B') },
    ]);
    expect(parseFeatureNoteList(raw)).toEqual([
      { path: '.agent/features/a.md', title: 'A' },
      { path: '.agent/features/b.md', title: 'B' },
    ]);
  });
});
