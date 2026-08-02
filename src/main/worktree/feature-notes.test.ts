import { describe, it, expect, vi } from 'vitest';
import { buildFeatureNoteListCommand, listFeatureNotes, parseFeatureNoteList } from './feature-notes';

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

describe('listFeatureNotes', () => {
  it('lists direct markdown notes from the configured directory', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: dump([{ path: 'notes/features/alpha.md', body: note('Alpha', 'in-progress') }]),
      stderr: '',
    });

    await expect(listFeatureNotes({ exec }, '/repo', ' notes/features/ ')).resolves.toEqual({
      ok: true,
      notes: [{ path: 'notes/features/alpha.md', title: 'Alpha', status: 'in-progress' }],
    });
    expect(exec).toHaveBeenCalledWith('/repo', expect.stringContaining("rel_dir='notes/features'"));
  });

  it('treats missing or empty configured directories as a successful empty list', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    await expect(listFeatureNotes({ exec }, '/repo', 'notes/features')).resolves.toEqual({
      ok: true,
      notes: [],
    });
  });

  it('returns the full connector error instead of collapsing it to an empty list', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('permission denied: notes/features'));
    await expect(listFeatureNotes({ exec }, '/repo', 'notes/features')).resolves.toEqual({
      ok: false,
      error: 'permission denied: notes/features',
    });
  });

  it('rejects listing output outside the configured directory', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: dump([{ path: '.agent/features/alpha.md', body: note('Alpha', 'in-progress') }]),
      stderr: '',
    });
    await expect(listFeatureNotes({ exec }, '/repo', 'notes/features')).resolves.toEqual({
      ok: false,
      error: 'Feature note listing returned a path outside the configured directory',
    });
  });

  it('rejects an unsafe directory before executing a connector command', async () => {
    const exec = vi.fn();
    const result = await listFeatureNotes({ exec }, '/repo', '../notes');
    expect(result).toEqual({
      ok: false,
      error: 'Feature note directory must not traverse parent directories',
    });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('buildFeatureNoteListCommand', () => {
  it('guards directory and note symlinks against escaping the physical project root', () => {
    const command = buildFeatureNoteListCommand("/repo's root", 'notes/features');
    expect(command).toContain("root_input='/repo'\\''s root'");
    expect(command).toContain('Configured feature note directory escapes project root');
    expect(command).toContain('Feature note escapes project root');
    expect(command).toContain('for f in "$dir"/*.md');
    expect(command).toContain('*/index.md');
  });
});
