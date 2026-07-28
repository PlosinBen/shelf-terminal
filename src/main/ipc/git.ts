import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { createConnector } from '../connector';
import { migrateFeatureNotes, restoreFeatureNotes } from '../worktree/note-migration';
import { listFeatureNotes } from '../worktree/feature-notes';
import { checkBranchMerged } from '../worktree/branch-merged';
import { mergeBackFastForward } from '../worktree/merge-back';
import { repoLockKey, tryAcquireRepoLock } from '../worktree/repo-lock';
import { shellSingleQuote } from '../connector/file-utils';
import type {
  Connection, GitBranchInfo, MigrateNoteResult, WorktreeAddResult, WorktreeRemoveResult,
  DeleteBranchResult, FinishMergeBackResult, FeatureNoteInfo, BranchMergedInfo,
} from '@shared/types';

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

        // Capture the parent's checked-out branch BEFORE creating the worktree —
        // this is the objective divergence point ("从哪里切出去就合并回哪里") that
        // `finish` later uses as its fixed ff merge-back target. Detached HEAD →
        // empty string (finish will fail-loud on merge-back rather than guess).
        const headResult = await connector
          .exec(payload.cwd, 'git rev-parse --abbrev-ref HEAD 2>/dev/null')
          .catch(() => ({ stdout: '', stderr: '' }));
        const rawHead = headResult.stdout.trim();
        const baseBranch = rawHead && rawHead !== 'HEAD' ? rawHead : undefined;

        const branchFlag = payload.newBranch ? '-b' : '';
        const cmd = branchFlag
          ? `git worktree add ${branchFlag} ${JSON.stringify(payload.branch)} ${JSON.stringify(worktreePath)}`
          : `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(payload.branch)}`;

        await connector.exec(payload.cwd, cmd);
        return { ok: true, path: worktreePath, baseBranch };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IPC.GIT_WORKTREE_REMOVE,
    async (_event, payload: { connection: Connection; cwd: string; worktreePath: string }): Promise<WorktreeRemoveResult> => {
      try {
        if (process.env.SHELF_TEST_MODE === '1' && process.env.SHELF_TEST_GIT_WORKTREE_REMOVE_ERROR) {
          return { ok: false, error: process.env.SHELF_TEST_GIT_WORKTREE_REMOVE_ERROR };
        }
        const connector = createConnector(payload.connection);
        await connector.exec(payload.cwd, `git worktree remove ${JSON.stringify(payload.worktreePath)}`);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IPC.GIT_MIGRATE_NOTE,
    async (
      _event,
      payload: { connection: Connection; baseCwd: string; worktreeCwd: string; notePaths: string[] },
    ): Promise<MigrateNoteResult> => {
      try {
        if (process.env.SHELF_TEST_MODE === '1' && process.env.SHELF_TEST_GIT_MIGRATE_NOTE_ERROR) {
          return { ok: false, error: process.env.SHELF_TEST_GIT_MIGRATE_NOTE_ERROR };
        }
        const connector = createConnector(payload.connection);
        const res = await migrateFeatureNotes(connector, payload.baseCwd, payload.worktreeCwd, payload.notePaths);
        return { ok: true, migrated: res.migrated };
      } catch (err: any) {
        // Fail-loud: given-but-missing / copy-failed surface to the caller, which
        // rolls back the just-created worktree rather than booting a broken one.
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IPC.GIT_RESTORE_NOTES,
    async (
      _event,
      payload: { connection: Connection; baseCwd: string; worktreeCwd: string },
    ): Promise<MigrateNoteResult> => {
      try {
        const connector = createConnector(payload.connection);
        const res = await restoreFeatureNotes(connector, payload.baseCwd, payload.worktreeCwd);
        return { ok: true, migrated: res.migrated };
      } catch (err: any) {
        // Fail-loud: close must not remove the worktree if any carried transient
        // note cannot be restored to the base checkout first.
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IPC.GIT_LIST_FEATURE_NOTES,
    async (_event, payload: { connection: Connection; cwd: string }): Promise<FeatureNoteInfo[]> => {
      try {
        const connector = createConnector(payload.connection);
        return await listFeatureNotes(connector, payload.cwd);
      } catch {
        // A missing `.agent/features/` or a listing hiccup is not fatal — the
        // picker just shows no notes (user can still create without one).
        return [];
      }
    },
  );

  ipcMain.handle(
    IPC.GIT_DELETE_BRANCH,
    async (
      _event,
      payload: { connection: Connection; cwd: string; branch: string; force?: boolean },
    ): Promise<DeleteBranchResult> => {
      try {
        const connector = createConnector(payload.connection);
        const flag = payload.force ? '-D' : '-d';
        await connector.exec(payload.cwd, `git branch ${flag} ${shellSingleQuote(payload.branch)}`);
        return { ok: true };
      } catch (err: any) {
        const msg = (err?.message ?? String(err)).replace(/^Error:\s*/, '');
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    IPC.GIT_BRANCH_MERGED,
    async (
      _event,
      payload: { connection: Connection; cwd: string; target: string; branch: string },
    ): Promise<BranchMergedInfo> => {
      try {
        const connector = createConnector(payload.connection);
        return await checkBranchMerged(connector, payload.cwd, payload.target, payload.branch);
      } catch {
        // Adaptive-warning input only — a hiccup falls back to the cautious
        // "unmerged" default (loud force-delete warning), never silently "safe".
        return { merged: false, aheadCount: 0 };
      }
    },
  );

  ipcMain.handle(
    IPC.WORKTREE_FINISH_MERGE_BACK,
    async (
      _event,
      payload: { connection: Connection; featureCwd: string; baseCwd: string; baseBranch: string; featureBranch: string },
    ): Promise<FinishMergeBackResult> => {
      // The repo lock wraps ONLY the "check main → ff" step: once the ff lands,
      // baseBranch has advanced and the subsequent teardown/branch-delete (this
      // feature's own cleanup) don't touch baseBranch, so another feature may
      // proceed. Losing the race → immediate busy (non-blocking).
      const key = repoLockKey(payload.connection, payload.baseCwd);
      const release = tryAcquireRepoLock(key);
      if (!release) return { outcome: 'busy' };
      try {
        const connector = createConnector(payload.connection);
        return await mergeBackFastForward({
          connector,
          featureCwd: payload.featureCwd,
          baseCwd: payload.baseCwd,
          baseBranch: payload.baseBranch,
          featureBranch: payload.featureBranch,
        });
      } finally {
        release();
      }
    },
  );
}
