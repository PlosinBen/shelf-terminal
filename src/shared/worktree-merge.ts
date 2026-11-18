/** Direct merge is a mutation; proposal tools remain UI-only. */
export const WORKTREE_MERGE = {
  TOOL: 'merge_worktree',
  OP: 'worktree.merge',
  OUTCOME: {
    MERGED: 'merged', BUSY: 'busy', NON_FF: 'non-ff',
    FEATURE_DIRTY: 'feature-dirty', BASE_DIRTY: 'base-dirty', ERROR: 'error',
  },
} as const;
export type WorktreeMergeOutcome = typeof WORKTREE_MERGE.OUTCOME[keyof typeof WORKTREE_MERGE.OUTCOME];
export type WorktreeMergeResult =
  | { outcome: typeof WORKTREE_MERGE.OUTCOME.MERGED; targetBranch: string; sourceCommit: string }
  | { outcome: Exclude<WorktreeMergeOutcome, typeof WORKTREE_MERGE.OUTCOME.MERGED>; targetBranch: string; sourceCommit?: string; error: string };
