import type { Connector } from '../connector/types';
import { shellSingleQuote as q } from '../connector/file-utils';

/**
 * ff-only merge-back for worktree `finish`.
 *
 * The invariant: the base branch only ever advances by fast-forward — never a
 * real `git merge <feature>`. sync (main→feature) already happened in the
 * worktree, so main is an ancestor of the feature tip and the merge-back is a
 * pure ref move. Two topologies, decided by whether baseBranch is checked out:
 *
 *  (a) baseBranch NOT checked out (base freed / on another branch) →
 *      `git push . HEAD:<baseBranch>` from the feature worktree updates the free
 *      ref directly, zero working-tree side effect. push natively rejects non-ff,
 *      so the invariant is self-enforcing.
 *
 *  (b) baseBranch checked out in the base worktree (e.g. base idle on main) →
 *      git refuses to push to a checked-out branch (denyCurrentBranch). Fall back
 *      to a `git merge --ff-only <featureBranch>` INSIDE the base worktree, which
 *      requires the base tree to be clean (dirty → fail-loud, don't touch it).
 *
 * "push succeeded" (or the base-tree ff succeeded) IS the assertion that the
 * merge-back happened and baseBranch now equals the feature tip — the caller
 * deletes the feature ref only on `merged`.
 */

export interface MergeBackParams {
  connector: Pick<Connector, 'exec'>;
  /** The feature worktree dir (cwd = /repo-<branch>, HEAD on featureBranch). */
  featureCwd: string;
  /** The base repo's main worktree dir. */
  baseCwd: string;
  /** Fixed ff target captured at create ("从哪里切出去就合并回哪里"). */
  baseBranch: string;
  /** The feature branch being merged back and later deleted. */
  featureBranch: string;
}

export type MergeBackOutcome =
  | { outcome: 'merged' }
  /** target moved ahead since sync → not a fast-forward; agent must re-sync + retry.
   *  `error` names the target branch + the git command attempted so the agent knows
   *  WHICH branch to re-sync. */
  | { outcome: 'non-ff'; error?: string }
  /** topology (b) but the base worktree has uncommitted changes → can't ff, don't touch. */
  | { outcome: 'base-dirty'; error?: string }
  | { outcome: 'error'; error: string };

function isCheckedOutRejection(msg: string): boolean {
  return /checked out|denycurrentbranch|currently checked out/i.test(msg);
}

function isNonFastForward(msg: string): boolean {
  return /non-fast-forward|fetch first|\[rejected\]|not possible to fast-forward|cannot fast-forward|not.*fast-forward/i.test(msg);
}

function nonFastForwardError(params: { baseBranch: string; attempted: string; msg: string; location?: string }): string {
  const { baseBranch, attempted, msg, location = '' } = params;
  return `merge-back into '${baseBranch}' is not a fast-forward (attempted \`${attempted}\`${location}): ${msg}. '${baseBranch}' moved since your last sync — rebase this worktree onto '${baseBranch}', resolve conflicts, re-verify, then finish again.`;
}

export async function mergeBackFastForward(params: MergeBackParams): Promise<MergeBackOutcome> {
  const { connector, featureCwd, baseCwd, baseBranch, featureBranch } = params;
  if (!baseBranch) {
    return { outcome: 'error', error: 'no baseBranch captured (detached HEAD at create?)' };
  }

  // Topology (a): push the feature tip onto baseBranch. Works when baseBranch is
  // a free (not checked-out) ref; push rejects non-ff for us.
  const pushCmd = `git push . HEAD:${baseBranch}`;
  try {
    await connector.exec(featureCwd, `git push . ${q(`HEAD:${baseBranch}`)}`);
    return { outcome: 'merged' };
  } catch (err: any) {
    const msg = (err?.message ?? String(err)).trim();
    if (!isCheckedOutRejection(msg)) {
      // Name the target branch + the command so the agent knows WHICH branch it
      // tried to merge into and can re-sync THAT branch (not guess).
      const nonFf = isNonFastForward(msg);
      return nonFf
        ? { outcome: 'non-ff', error: nonFastForwardError({ baseBranch, attempted: pushCmd, msg }) }
        : { outcome: 'error', error: `merge-back into '${baseBranch}' failed (attempted \`${pushCmd}\`): ${msg}` };
    }
    // else fall through to topology (b)
  }

  // Topology (b): baseBranch is checked out. Only the base worktree may advance it.
  // Guard: the ff must run in the worktree actually on baseBranch — if base is on
  // some other branch (baseBranch checked out in a THIRD worktree), fail-loud
  // rather than ff the wrong branch.
  let baseHead = '';
  try {
    const r = await connector.exec(baseCwd, 'git rev-parse --abbrev-ref HEAD 2>/dev/null');
    baseHead = r.stdout.trim();
  } catch (err: any) {
    return { outcome: 'error', error: err?.message ?? String(err) };
  }
  if (baseHead !== baseBranch) {
    return {
      outcome: 'error',
      error: `baseBranch '${baseBranch}' is checked out but not in the base worktree (base is on '${baseHead}') — merge back manually`,
    };
  }

  // Base must be clean — an ff still moves the working tree, and we never discard
  // someone else's uncommitted work in the base repo.
  try {
    const dirty = await connector.exec(baseCwd, 'git status --porcelain 2>/dev/null');
    if (dirty.stdout.trim().length > 0) {
      return { outcome: 'base-dirty', error: `cannot fast-forward '${baseBranch}': its base worktree has uncommitted changes. Resolve them in the base worktree, then finish again.` };
    }
  } catch (err: any) {
    return { outcome: 'error', error: err?.message ?? String(err) };
  }

  const mergeCmd = `git merge --ff-only ${featureBranch}`;
  try {
    await connector.exec(baseCwd, `git merge --ff-only ${q(featureBranch)}`);
    return { outcome: 'merged' };
  } catch (err: any) {
    const msg = (err?.message ?? String(err)).trim();
    const nonFf = isNonFastForward(msg);
    return nonFf
      ? { outcome: 'non-ff', error: nonFastForwardError({ baseBranch, attempted: mergeCmd, location: ' in the base worktree', msg }) }
      : { outcome: 'error', error: `merge-back into '${baseBranch}' failed (attempted \`${mergeCmd}\`): ${msg}` };
  }
}
