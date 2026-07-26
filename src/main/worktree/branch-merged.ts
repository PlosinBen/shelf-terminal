import type { Connector } from '../connector/types';
import type { BranchMergedInfo } from '@shared/types';
import { shellSingleQuote as q } from '../connector/file-utils';

/**
 * "Is the feature branch already merged into the target?" check that drives the
 * Abandon popup's adaptive warning (#lifecycle):
 *
 *  - merged  → deleting the branch is safe (its commits live on the target);
 *  - unmerged → force-deleting discards `aheadCount` commits (the loud warning).
 *
 * merged = the branch is reachable from the target (listed by `git branch
 * --merged <target>`). aheadCount = commits on the branch not on the target
 * (`git rev-list --count <target>..<branch>`) — what a force delete would drop.
 *
 * NOTE: the check is against the LOCAL target ref. A branch merged only on a
 * remote (e.g. via a PR that hasn't been pulled) reads as unmerged here — pull
 * the target first for the warning to reflect it.
 */

export async function checkBranchMerged(
  connector: Pick<Connector, 'exec'>,
  cwd: string,
  target: string,
  branch: string,
): Promise<BranchMergedInfo> {
  if (!target || !branch) return { merged: false, aheadCount: 0 };

  // A branch checked out in a worktree shows with a `+` prefix, the current one
  // with `*`; strip either before matching (mirrors git.ts's branch parsing).
  const listed = await connector.exec(cwd, `git branch --merged ${q(target)} --no-color 2>/dev/null`);
  const merged = listed.stdout
    .split('\n')
    .map((l) => l.replace(/^[*+]?\s+/, '').trim())
    .includes(branch);

  let aheadCount = 0;
  try {
    const r = await connector.exec(cwd, `git rev-list --count ${q(`${target}..${branch}`)} 2>/dev/null`);
    aheadCount = parseInt(r.stdout.trim(), 10) || 0;
  } catch {
    aheadCount = 0;
  }

  return { merged, aheadCount };
}
