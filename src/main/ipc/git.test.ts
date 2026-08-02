import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Connection } from '@shared/types';

// Capture the handlers registered via ipcMain.handle so we can invoke them.
const handlers = new Map<string, (...a: any[]) => any>();
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}));

// A scriptable connector: exec(cwd, cmd) resolves whatever `execImpl` returns.
let execImpl: (cwd: string, cmd: string) => Promise<{ stdout: string; stderr: string }>;
const execCalls: Array<{ cwd: string; cmd: string }> = [];
vi.mock('../connector', () => ({
  createConnector: () => ({
    exec: (cwd: string, cmd: string) => {
      execCalls.push({ cwd, cmd });
      return execImpl(cwd, cmd);
    },
  }),
}));

const { registerGitHandlers } = await import('./git');
const { IPC } = await import('@shared/ipc-channels');

const connection = { type: 'local' } as unknown as Connection;

beforeEach(() => {
  delete process.env.SHELF_TEST_MODE;
  delete process.env.SHELF_TEST_GIT_MIGRATE_NOTE_ERROR;
  delete process.env.SHELF_TEST_GIT_WORKTREE_REMOVE_ERROR;
  handlers.clear();
  execCalls.length = 0;
  execImpl = async () => ({ stdout: '', stderr: '' });
  registerGitHandlers();
});

describe('GIT_WORKTREE_ADD captures the parent baseBranch', () => {
  it('returns the parent checked-out branch as baseBranch', async () => {
    execImpl = async (_cwd, cmd) => {
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) return { stdout: 'main\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    const res = await handlers.get(IPC.GIT_WORKTREE_ADD)!({}, {
      connection,
      cwd: '/repo',
      branch: 'feature/x',
      newBranch: true,
    });

    expect(res.ok).toBe(true);
    expect(res.baseBranch).toBe('main');
    // HEAD must be read BEFORE the worktree is created (parent state at cut time).
    const revParseIdx = execCalls.findIndex((c) => c.cmd.includes('rev-parse'));
    const addIdx = execCalls.findIndex((c) => c.cmd.includes('worktree add'));
    expect(revParseIdx).toBeGreaterThanOrEqual(0);
    expect(revParseIdx).toBeLessThan(addIdx);
  });

  it('leaves baseBranch undefined on detached HEAD (no guessing)', async () => {
    execImpl = async (_cwd, cmd) => {
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) return { stdout: 'HEAD\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    const res = await handlers.get(IPC.GIT_WORKTREE_ADD)!({}, {
      connection,
      cwd: '/repo',
      branch: 'feature/x',
      newBranch: true,
    });

    expect(res.ok).toBe(true);
    expect(res.baseBranch).toBeUndefined();
  });

  it('does not fail creation when HEAD detection errors', async () => {
    execImpl = async (_cwd, cmd) => {
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) throw new Error('git blew up');
      return { stdout: '', stderr: '' };
    };

    const res = await handlers.get(IPC.GIT_WORKTREE_ADD)!({}, {
      connection,
      cwd: '/repo',
      branch: 'feature/x',
      newBranch: true,
    });

    expect(res.ok).toBe(true);
    expect(res.baseBranch).toBeUndefined();
  });
});

describe('GIT_WORKTREE_REMOVE', () => {
  it('removes the worktree without --force so git can refuse dirty leftovers', async () => {
    const res = await handlers.get(IPC.GIT_WORKTREE_REMOVE)!({}, {
      connection,
      cwd: '/repo',
      worktreePath: '/repo-feature',
    });

    expect(res).toEqual({ ok: true });
    expect(execCalls).toEqual([
      { cwd: '/repo', cmd: 'git worktree remove "/repo-feature"' },
    ]);
  });

  it('can inject a test-mode failure for create rollback E2E coverage', async () => {
    process.env.SHELF_TEST_MODE = '1';
    process.env.SHELF_TEST_GIT_WORKTREE_REMOVE_ERROR = 'forced remove failure';

    const res = await handlers.get(IPC.GIT_WORKTREE_REMOVE)!({}, {
      connection,
      cwd: '/repo',
      worktreePath: '/repo-feature',
    });

    expect(res).toEqual({ ok: false, error: 'forced remove failure' });
    expect(execCalls).toHaveLength(0);
  });
});

describe('GIT_MIGRATE_NOTE', () => {
  it('passes multiple note paths to the batch migrator', async () => {
    execImpl = async (_cwd, cmd) => {
      if (cmd.startsWith('test -f')) return { stdout: '__SHELF_NOTE_OK__\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    const res = await handlers.get(IPC.GIT_MIGRATE_NOTE)!({}, {
      connection,
      baseCwd: '/repo',
      worktreeCwd: '/repo-feature',
      notePaths: ['.agent/features/a.md', '.agent/features/b.md'],
    });

    expect(res).toEqual({ ok: true, migrated: true });
    expect(execCalls.some((c) => c.cmd.includes('/repo/.agent/features/a.md'))).toBe(true);
    expect(execCalls.some((c) => c.cmd.includes('/repo/.agent/features/b.md'))).toBe(true);
  });

  it('can inject a test-mode migration failure for create recovery E2E coverage', async () => {
    process.env.SHELF_TEST_MODE = '1';
    process.env.SHELF_TEST_GIT_MIGRATE_NOTE_ERROR = 'forced migrate failure';

    const res = await handlers.get(IPC.GIT_MIGRATE_NOTE)!({}, {
      connection,
      baseCwd: '/repo',
      worktreeCwd: '/repo-feature',
      notePaths: ['.agent/features/a.md'],
    });

    expect(res).toEqual({ ok: false, error: 'forced migrate failure' });
    expect(execCalls).toHaveLength(0);
  });
});

describe('GIT_RESTORE_NOTES', () => {
  it('returns migrated=false when the worktree has no feature notes', async () => {
    execImpl = async (_cwd, cmd) => {
      if (cmd.includes('for f in "$dir"/*.md')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    const res = await handlers.get(IPC.GIT_RESTORE_NOTES)!({}, {
      connection,
      baseCwd: '/repo',
      worktreeCwd: '/repo-feature',
      featureNoteDir: '.agent/features',
    });

    expect(res).toEqual({ ok: true, migrated: false });
  });

  it('fails loud when restore would overwrite a base note', async () => {
    execImpl = async (_cwd, cmd) => {
      if (cmd.includes('for f in "$dir"/*.md')) {
        return { stdout: '===SHELF_NOTE:.agent/features/x.md===\n---\ntitle: X\n---\n', stderr: '' };
      }
      if (cmd.startsWith('test ! -e')) return { stdout: '__SHELF_NOTE_MISSING__\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    const res = await handlers.get(IPC.GIT_RESTORE_NOTES)!({}, {
      connection,
      baseCwd: '/repo',
      worktreeCwd: '/repo-feature',
      featureNoteDir: '.agent/features',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('already exists');
  });
});

describe('GIT_LIST_FEATURE_NOTES', () => {
  it('returns an explicit successful empty result for a missing directory', async () => {
    const res = await handlers.get(IPC.GIT_LIST_FEATURE_NOTES)!({}, {
      connection,
      cwd: '/repo',
      featureNoteDir: 'notes/features',
    });

    expect(res).toEqual({ ok: true, notes: [] });
    expect(execCalls[0]?.cmd).toContain("rel_dir='notes/features'");
  });

  it('preserves connector failures as explicit listing errors', async () => {
    execImpl = async () => { throw new Error('remote permission denied'); };
    const res = await handlers.get(IPC.GIT_LIST_FEATURE_NOTES)!({}, {
      connection,
      cwd: '/repo',
      featureNoteDir: 'notes/features',
    });

    expect(res).toEqual({ ok: false, error: 'remote permission denied' });
  });
});
