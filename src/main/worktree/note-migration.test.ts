import { describe, it, expect } from 'vitest';
import { migrateFeatureNote, migrateFeatureNotes, restoreFeatureNotes } from './note-migration';

/** A scriptable connector.exec that records calls and dispatches on the command. */
function makeConnector(handler: (cwd: string, cmd: string) => { stdout?: string; stderr?: string } | Error) {
  const calls: Array<{ cwd: string; cmd: string }> = [];
  return {
    calls,
    connector: {
      exec: async (cwd: string, cmd: string) => {
        calls.push({ cwd, cmd });
        const r = handler(cwd, cmd);
        if (r instanceof Error) throw r;
        return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      },
    },
  };
}

describe('migrateFeatureNote', () => {
  it('no notePath → degenerate no-op, no shell calls', async () => {
    const { connector, calls } = makeConnector(() => ({}));
    const res = await migrateFeatureNote(connector, '/base', '/base-wt', undefined);
    expect(res.migrated).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('empty/whitespace notePath → no-op', async () => {
    const { connector, calls } = makeConnector(() => ({}));
    const res = await migrateFeatureNote(connector, '/base', '/base-wt', '   ');
    expect(res.migrated).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('happy path: copy into worktree, verify, then delete source', async () => {
    const seq: string[] = [];
    const { connector } = makeConnector((_cwd, cmd) => {
      if (cmd.startsWith('test -f')) return { stdout: '__SHELF_NOTE_OK__\n' };
      if (cmd.includes('cp ')) { seq.push('copy'); return {}; }
      if (cmd.startsWith('rm -f')) { seq.push('remove'); return {}; }
      return {};
    });
    const res = await migrateFeatureNote(connector, '/base', '/base-wt', '.agent/features/x.md');
    expect(res.migrated).toBe(true);
    // copy must precede remove (copy-then-delete-on-success).
    expect(seq).toEqual(['copy', 'remove']);
  });

  it('given-but-missing source → fail-loud, no copy, no remove', async () => {
    const { connector, calls } = makeConnector((_cwd, cmd) => {
      if (cmd.startsWith('test -f')) return { stdout: '__SHELF_NOTE_MISSING__\n' };
      return {};
    });
    await expect(
      migrateFeatureNote(connector, '/base', '/base-wt', '.agent/features/x.md'),
    ).rejects.toThrow(/not found/);
    expect(calls.some((c) => c.cmd.includes('cp '))).toBe(false);
    expect(calls.some((c) => c.cmd.startsWith('rm -f'))).toBe(false);
  });

  it('copy did not land → fail-loud, source kept (no remove)', async () => {
    const { connector, calls } = makeConnector((_cwd, cmd) => {
      if (cmd.startsWith('test -f')) {
        // source exists, but dest verify says missing
        return cmd.includes('/base-wt/')
          ? { stdout: '__SHELF_NOTE_MISSING__\n' }
          : { stdout: '__SHELF_NOTE_OK__\n' };
      }
      return {};
    });
    await expect(
      migrateFeatureNote(connector, '/base', '/base-wt', '.agent/features/x.md'),
    ).rejects.toThrow(/copy failed/);
    expect(calls.some((c) => c.cmd.startsWith('rm -f') && c.cwd === '/base')).toBe(false);
    expect(calls.some((c) => c.cmd.startsWith('rm -f') && c.cwd === '/base-wt')).toBe(true);
  });

  it('rejects absolute notePath', async () => {
    const { connector } = makeConnector(() => ({}));
    await expect(
      migrateFeatureNote(connector, '/base', '/base-wt', '/etc/passwd'),
    ).rejects.toThrow(/relative/);
  });

  it('rejects parent-traversal notePath', async () => {
    const { connector } = makeConnector(() => ({}));
    await expect(
      migrateFeatureNote(connector, '/base', '/base-wt', '../../../secret.md'),
    ).rejects.toThrow(/traverse/);
  });
});

describe('migrateFeatureNotes', () => {
  it('empty notePaths → degenerate no-op, no shell calls', async () => {
    const { connector, calls } = makeConnector(() => ({}));
    const res = await migrateFeatureNotes(connector, '/base', '/base-wt', []);
    expect(res.migrated).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('happy path: copies and verifies every note before deleting base copies', async () => {
    const seq: string[] = [];
    const { connector } = makeConnector((_cwd, cmd) => {
      if (cmd.startsWith('test -f')) return { stdout: '__SHELF_NOTE_OK__\n' };
      if (cmd.includes('cp ')) { seq.push(`copy:${cmd}`); return {}; }
      if (cmd.startsWith('rm -f')) { seq.push(`remove:${cmd}`); return {}; }
      return {};
    });

    const res = await migrateFeatureNotes(connector, '/base', '/base-wt', [
      '.agent/features/a.md',
      '.agent/features/b.md',
    ]);

    expect(res.migrated).toBe(true);
    expect(seq).toHaveLength(3);
    expect(seq[0]).toContain('/base/.agent/features/a.md');
    expect(seq[1]).toContain('/base/.agent/features/b.md');
    expect(seq[2]).toContain('rm -f');
  });

  it('mid-batch copy failure keeps all base notes and removes worktree-side copies already made', async () => {
    const { connector, calls } = makeConnector((_cwd, cmd) => {
      if (cmd.startsWith('test -f')) return { stdout: '__SHELF_NOTE_OK__\n' };
      if (cmd.includes('/base/.agent/features/b.md') && cmd.includes('cp ')) {
        throw new Error('copy b failed');
      }
      return {};
    });

    await expect(
      migrateFeatureNotes(connector, '/base', '/base-wt', [
        '.agent/features/a.md',
        '.agent/features/b.md',
      ]),
    ).rejects.toThrow(/copy b failed/);

    expect(calls.some((c) => c.cmd.startsWith('rm -f') && c.cwd === '/base')).toBe(false);
    expect(calls.some((c) => c.cmd.startsWith('rm -f') && c.cwd === '/base-wt')).toBe(true);
    expect(calls.find((c) => c.cmd.startsWith('rm -f') && c.cwd === '/base-wt')?.cmd).toContain(
      '/base-wt/.agent/features/a.md',
    );
  });

  it('mid-batch verify failure keeps all base notes and removes worktree-side copies already made', async () => {
    const { connector, calls } = makeConnector((_cwd, cmd) => {
      if (cmd.startsWith('test -f')) {
        if (cmd.includes('/base-wt/.agent/features/b.md')) {
          return { stdout: '__SHELF_NOTE_MISSING__\n' };
        }
        return { stdout: '__SHELF_NOTE_OK__\n' };
      }
      return {};
    });

    await expect(
      migrateFeatureNotes(connector, '/base', '/base-wt', [
        '.agent/features/a.md',
        '.agent/features/b.md',
      ]),
    ).rejects.toThrow(/copy failed/);

    expect(calls.some((c) => c.cmd.startsWith('rm -f') && c.cwd === '/base')).toBe(false);
    const cleanup = calls.find((c) => c.cmd.startsWith('rm -f') && c.cwd === '/base-wt');
    expect(cleanup?.cmd).toContain('/base-wt/.agent/features/a.md');
    expect(cleanup?.cmd).toContain('/base-wt/.agent/features/b.md');
  });

  it('given-but-missing source before copy phase → fail-loud, no copy, no remove', async () => {
    const { connector, calls } = makeConnector((_cwd, cmd) => {
      if (cmd.startsWith('test -f')) {
        return cmd.includes('/base/.agent/features/b.md')
          ? { stdout: '__SHELF_NOTE_MISSING__\n' }
          : { stdout: '__SHELF_NOTE_OK__\n' };
      }
      return {};
    });

    await expect(
      migrateFeatureNotes(connector, '/base', '/base-wt', [
        '.agent/features/a.md',
        '.agent/features/b.md',
      ]),
    ).rejects.toThrow(/not found/);

    expect(calls.some((c) => c.cmd.includes('cp '))).toBe(false);
    expect(calls.some((c) => c.cmd.startsWith('rm -f'))).toBe(false);
  });
});

describe('restoreFeatureNotes', () => {
  it('no notes in worktree → no-op', async () => {
    const { connector, calls } = makeConnector((_cwd, cmd) => {
      if (cmd.startsWith('for f in .agent/features/*.md')) return { stdout: '' };
      return {};
    });

    const res = await restoreFeatureNotes(connector, '/base', '/base-wt');

    expect(res.migrated).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('happy path: copy each remaining worktree note to base, verify, then remove source', async () => {
    const seq: string[] = [];
    const { connector } = makeConnector((cwd, cmd) => {
      if (cmd.startsWith('for f in .agent/features/*.md')) {
        return { stdout: '===SHELF_NOTE:.agent/features/x.md===\n---\ntitle: X\n---\n' };
      }
      if (cmd.startsWith('test ! -e')) return { stdout: '__SHELF_NOTE_OK__\n' };
      if (cmd.includes('cp ')) { seq.push(`copy:${cwd}`); return {}; }
      if (cmd.startsWith('test -f')) return { stdout: '__SHELF_NOTE_OK__\n' };
      if (cmd.startsWith('rm -f')) { seq.push(`remove:${cwd}`); return {}; }
      return {};
    });

    const res = await restoreFeatureNotes(connector, '/base', '/base-wt');

    expect(res.migrated).toBe(true);
    expect(seq).toEqual(['copy:/base-wt', 'remove:/base-wt']);
  });

  it('base destination already exists → fail-loud and keep worktree source', async () => {
    const { connector, calls } = makeConnector((_cwd, cmd) => {
      if (cmd.startsWith('for f in .agent/features/*.md')) {
        return { stdout: '===SHELF_NOTE:.agent/features/x.md===\n---\ntitle: X\n---\n' };
      }
      if (cmd.startsWith('test ! -e')) return { stdout: '__SHELF_NOTE_MISSING__\n' };
      return {};
    });

    await expect(restoreFeatureNotes(connector, '/base', '/base-wt')).rejects.toThrow(/already exists/);
    expect(calls.some((c) => c.cmd.includes('cp '))).toBe(false);
    expect(calls.some((c) => c.cmd.startsWith('rm -f'))).toBe(false);
  });

  it('copy did not land in base → fail-loud and keep worktree source', async () => {
    const { connector, calls } = makeConnector((_cwd, cmd) => {
      if (cmd.startsWith('for f in .agent/features/*.md')) {
        return { stdout: '===SHELF_NOTE:.agent/features/x.md===\n---\ntitle: X\n---\n' };
      }
      if (cmd.startsWith('test ! -e')) return { stdout: '__SHELF_NOTE_OK__\n' };
      if (cmd.startsWith('test -f')) return { stdout: '__SHELF_NOTE_MISSING__\n' };
      return {};
    });

    await expect(restoreFeatureNotes(connector, '/base', '/base-wt')).rejects.toThrow(/restore failed/);
    expect(calls.some((c) => c.cmd.startsWith('rm -f'))).toBe(false);
  });
});
