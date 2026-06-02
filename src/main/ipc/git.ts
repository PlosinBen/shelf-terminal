import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { createConnector } from '../connector';
import type { Connection, GitBranchInfo, WorktreeAddResult, WorktreeRemoveResult } from '@shared/types';

export function registerGitHandlers(): void {
  ipcMain.handle(IPC.GIT_BRANCH_LIST, async (_event, payload: { connection: Connection; cwd: string }): Promise<GitBranchInfo[]> => {
    try {
      const connector = createConnector(payload.connection);
      const [branchResult, worktreeResult] = await Promise.all([
        connector.exec(payload.cwd, 'git branch --no-color 2>/dev/null'),
        connector.exec(payload.cwd, 'git worktree list --porcelain 2>/dev/null').catch(() => ({ stdout: '', stderr: '' })),
      ]);

      // Parse worktree list to map branch → path
      const worktreeMap = new Map<string, string>();
      let currentPath = '';
      for (const line of worktreeResult.stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          currentPath = line.slice('worktree '.length);
        } else if (line.startsWith('branch refs/heads/')) {
          worktreeMap.set(line.slice('branch refs/heads/'.length), currentPath);
        }
      }

      return branchResult.stdout.trim().split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
          const name = line.replace(/^[*+]?\s+/, '');
          const isCurrent = line.startsWith('*');
          const worktreePath = !isCurrent ? worktreeMap.get(name) : undefined;
          return { name, current: isCurrent, worktreePath };
        });
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.GIT_CHECK_DIRTY, async (_event, payload: { connection: Connection; cwd: string }): Promise<boolean> => {
    try {
      const connector = createConnector(payload.connection);
      const { stdout } = await connector.exec(payload.cwd, 'git status --porcelain 2>/dev/null');
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC.GIT_CHECKOUT, async (_event, payload: { connection: Connection; cwd: string; branch: string }): Promise<{ ok: boolean; error?: string }> => {
    try {
      const connector = createConnector(payload.connection);
      await connector.exec(payload.cwd, `git checkout ${JSON.stringify(payload.branch)}`);
      return { ok: true };
    } catch (err: any) {
      const msg = (err?.message ?? String(err)).replace(/^Error:\s*/, '');
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(
    IPC.GIT_WORKTREE_ADD,
    async (_event, payload: { connection: Connection; cwd: string; branch: string; newBranch: boolean }): Promise<WorktreeAddResult> => {
      try {
        const connector = createConnector(payload.connection);
        const parentDir = payload.cwd.replace(/\/+$/, '').replace(/[^/]+$/, '').replace(/\/+$/, '');
        const dirName = `${payload.cwd.replace(/\/+$/, '').split('/').pop()}-${payload.branch.replace(/\//g, '-')}`;
        const worktreePath = `${parentDir}/${dirName}`;

        const branchFlag = payload.newBranch ? '-b' : '';
        const cmd = branchFlag
          ? `git worktree add ${branchFlag} ${JSON.stringify(payload.branch)} ${JSON.stringify(worktreePath)}`
          : `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(payload.branch)}`;

        await connector.exec(payload.cwd, cmd);
        return { ok: true, path: worktreePath };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IPC.GIT_WORKTREE_REMOVE,
    async (_event, payload: { connection: Connection; cwd: string; worktreePath: string }): Promise<WorktreeRemoveResult> => {
      try {
        const connector = createConnector(payload.connection);
        await connector.exec(payload.cwd, `git worktree remove ${JSON.stringify(payload.worktreePath)} --force`);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );
}
