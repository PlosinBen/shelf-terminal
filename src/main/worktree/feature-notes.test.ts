import { describe, it, expect } from 'vitest';
import { parseFeatureNoteList } from './feature-notes';

/** Build the shell-dump shape parseFeatureNoteList consumes. */
function dump(entries: { path: string; body: string }[]): string {
  return entries.map((e) => `===SHELF_NOTE:${e.path}===\n${e.body}`).join('\n');
}

const note = (title: string, status: string) =>
  `---\ntype: feature\ntitle: ${title}\nstatus: ${status}\n---\n\n# ${title}\n`;

describe('parseFeatureNoteList', () => {
  it('returns a note with its title, status and relative path', () => {
    const raw = dump([{ path: '.agent/features/alpha.md', body: note('Alpha', 'in-progress') }]);
    expect(parseFeatureNoteList(raw)).toEqual([
      { path: '.agent/features/alpha.md', title: 'Alpha', status: 'in-progress' },
    ]);
  });

  it('lists ALL notes regardless of status — filtering is the user\'s job', () => {
    const raw = dump([
      { path: '.agent/features/live.md', body: note('Live', 'in-progress') },
      { path: '.agent/features/paused.md', body: note('Paused', 'pending') },
      { path: '.agent/features/dead.md', body: note('Dead', 'cancelled') },
    ]);
    expect(parseFeatureNoteList(raw)).toEqual([
      { path: '.agent/features/live.md', title: 'Live', status: 'in-progress' },
      { path: '.agent/features/paused.md', title: 'Paused', status: 'pending' },
      { path: '.agent/features/dead.md', title: 'Dead', status: 'cancelled' },
    ]);
  });

  it('includes a note with no / malformed frontmatter (path only)', () => {
    const raw = dump([
      { path: '.agent/features/plain.md', body: '# Just a heading, no frontmatter\n' },
      { path: '.agent/features/ok.md', body: note('Ok', 'in-progress') },
    ]);
    expect(parseFeatureNoteList(raw)).toEqual([
      { path: '.agent/features/plain.md' },
      { path: '.agent/features/ok.md', title: 'Ok', status: 'in-progress' },
    ]);
  });

  it('omits title/status keys when the frontmatter lacks them', () => {
    const raw = dump([
      { path: '.agent/features/titleonly.md', body: '---\ntype: feature\ntitle: Just Title\n---\n' },
    ]);
    expect(parseFeatureNoteList(raw)).toEqual([
      { path: '.agent/features/titleonly.md', title: 'Just Title' },
    ]);
  });

  it('strips quotes around a quoted title', () => {
    const raw = dump([
      { path: '.agent/features/q.md', body: '---\ntitle: "Quoted: Title"\nstatus: in-progress\n---\n' },
    ]);
    expect(parseFeatureNoteList(raw)).toEqual([
      { path: '.agent/features/q.md', title: 'Quoted: Title', status: 'in-progress' },
    ]);
  });

  it('returns [] for empty output (no feature notes)', () => {
    expect(parseFeatureNoteList('')).toEqual([]);
  });

  it('tolerates leading blank lines before the frontmatter fence', () => {
    const raw = dump([
      { path: '.agent/features/pad.md', body: '\n\n---\ntitle: Padded\nstatus: pending\n---\n' },
    ]);
    expect(parseFeatureNoteList(raw)).toEqual([
      { path: '.agent/features/pad.md', title: 'Padded', status: 'pending' },
    ]);
  });

  it('keeps notes in dump order', () => {
    const raw = dump([
      { path: '.agent/features/a.md', body: note('A', 'in-progress') },
      { path: '.agent/features/b.md', body: note('B', 'pending') },
    ]);
    expect(parseFeatureNoteList(raw).map((n) => n.path)).toEqual([
      '.agent/features/a.md',
      '.agent/features/b.md',
    ]);
  });
});
