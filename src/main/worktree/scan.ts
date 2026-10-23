import type { WorktreeIdentity } from '@shared/worktree';
import type { WorktreeProbe } from '../connector/worktree-probe';
import { parseWorktreeList, sameWorktree, type InspectedWorktree } from './inspect';
export interface WorktreeSnapshot {
  main: WorktreeIdentity;
  branch: string | null;
  worktrees: InspectedWorktree[];
}
export async function scanWorktrees(probe: WorktreeProbe, cwd: string): Promise<WorktreeSnapshot | null> {
  const main = await probe.identity(cwd);
  if (!main) return null;
  const before = await probe.git(cwd, 'worktree', 'list', '--porcelain', '-z');
  const records = parseWorktreeList(before);
  const worktrees: InspectedWorktree[] = [];
  let branch: string | null = null;
  let foundMain = false;
  for (const record of records) {
    if (record.bare) continue;
    const identity = await probe.identity(record.path);
    if (!identity) continue;
    if (identity.commonDir !== main.commonDir) continue;
    // A registration replaced by an ordinary subdirectory must not inherit
    // its ancestor's Git identity. Git returns canonical paths in its list.
    if (identity.checkoutPath !== record.path) continue;
    if (sameWorktree(identity, main)) { branch = record.branch; foundMain = true; }
    else worktrees.push({ ...record, identity });
  }
  if (!foundMain) throw new Error(`Main checkout is absent from worktree list: ${cwd}`);
  if (before !== await probe.git(cwd, 'worktree', 'list', '--porcelain', '-z')) throw new Error('Worktree list changed during scan; rescan to retry');
  return { main, branch, worktrees };
}
