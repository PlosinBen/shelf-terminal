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
