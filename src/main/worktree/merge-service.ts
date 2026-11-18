import { log } from '@shared/logger';
import { WORKTREE_MERGE as M, type WorktreeMergeResult } from '@shared/worktree-merge';
import { isWorktreeUnavailable } from '@shared/worktree';
import type { Connection, FinishMergeBackResult } from '@shared/types';
import { createConnector } from '../connector';
import { shellSingleQuote as q } from '../connector/file-utils';
import { getProjectsRepository } from '../projects/repository-provider';
import { mergeBackFastForward } from './merge-back';
import { repoLockKey, tryAcquireRepoLock } from './repo-lock';
import { inspectWorktreeSource, setWorktreeLifecycle } from './reconcile';

interface MergeParams {
  connection: Connection;
  featureCwd: string;
  baseCwd: string;
  baseBranch: string;
  featureBranch: string;
  sourceCommit?: string;
  isActive?: () => boolean;
}

/** UI and MCP share the same non-blocking repo lock and ff-only operation. */
export async function mergeBackWithLock(params: MergeParams): Promise<FinishMergeBackResult> {
  const release = tryAcquireRepoLock(repoLockKey(params.connection, params.baseCwd));
  if (!release) return { outcome: M.OUTCOME.BUSY, error: 'Another merge is in progress for this repository' };
  try {
    const connector = createConnector(params.connection);
    // A merge must not silently create a misspelled target branch.
    if (!params.baseBranch || params.baseBranch.startsWith('-')) throw new Error('An explicit target branch is required');
    await connector.exec(params.baseCwd, `git check-ref-format ${q(`refs/heads/${params.baseBranch}`)}`);
    await connector.exec(params.baseCwd, `git show-ref --verify ${q(`refs/heads/${params.baseBranch}`)}`);
    if (params.isActive && !params.isActive()) throw new Error('Inactive Agent channel; merge was not started');
    return await mergeBackFastForward({ ...params, connector });
  } catch (error) {
    return { outcome: M.OUTCOME.ERROR, error: error instanceof Error ? error.message : String(error) };
  } finally { release(); }
}

/** worktree#23: trusted caller scope, no gate, notes, cleanup or automatic retry. */
export async function mergeWorktreeProject(projectId: string | undefined, targetBranch: string, isActive?: () => boolean): Promise<WorktreeMergeResult> {
  let sourceCommit: string | undefined;
  let lifecycleProject: string | undefined;
  const fail = (outcome: Exclude<WorktreeMergeResult['outcome'], typeof M.OUTCOME.MERGED>, error: string): WorktreeMergeResult =>
    ({ outcome, targetBranch, ...(sourceCommit ? { sourceCommit } : {}), error });
  try {
    if (!targetBranch || targetBranch !== targetBranch.trim()) throw new Error('targetBranch must be an explicit non-empty branch name');
    const repository = getProjectsRepository();
    const project = projectId ? repository.get(projectId) : undefined;
    if (!project?.parentProjectId) throw new Error('merge_worktree requires a worktree project context');
    if (isWorktreeUnavailable(project)) throw new Error('Worktree is unavailable; rescan it in Shelf');
    const parent = repository.get(project.parentProjectId);
    if (!parent) throw new Error('Worktree parent is missing');
    try { setWorktreeLifecycle(parent.id, true); }
    catch (error) { return fail(M.OUTCOME.BUSY, String(error)); }
    lifecycleProject = parent.id;
    const source = await inspectWorktreeSource(project.id);
    sourceCommit = source.commit;
    const result = await mergeBackWithLock({
      connection: project.connection, featureCwd: project.cwd, baseCwd: parent.cwd,
      baseBranch: targetBranch, featureBranch: source.branch ?? '', sourceCommit, isActive,
    });
    return result.outcome === M.OUTCOME.MERGED
      ? { outcome: M.OUTCOME.MERGED, sourceCommit, targetBranch }
      : fail(result.outcome, result.error ?? `Merge failed: ${result.outcome}`);
  } catch (error) {
    return fail(M.OUTCOME.ERROR, error instanceof Error ? error.message : String(error));
  } finally {
    if (lifecycleProject) {
      try { setWorktreeLifecycle(lifecycleProject, false); }
      catch (error) { log.error('worktree-merge', `Lifecycle release failed projectId=${lifecycleProject}; Git outcome is unchanged: ${String(error)}`); }
    }
  }
}
