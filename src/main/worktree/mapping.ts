import type { Project } from '@shared/projects';
import { WorktreeAvailability, type WorktreeIdentity } from '@shared/worktree';
import { sameWorktree, type InspectedWorktree } from './inspect';

export function mapWorktrees(children: readonly Project[], identities: ReadonlyMap<string, WorktreeIdentity | null>, candidates: readonly InspectedWorktree[]) {
  const used = new Set<InspectedWorktree>();
  const updates = children.map(child => {
    const identity = identities.get(child.id);
    const matches = candidates.filter(candidate => identity ? sameWorktree(identity, candidate.identity)
      : child.worktreeState?.identity ? sameWorktree(child.worktreeState.identity, candidate.identity)
      : child.cwd === candidate.path);
    if (matches.length > 1 || (matches[0] && used.has(matches[0]))) throw new Error(`Ambiguous worktree mapping for ${child.id}`);
    const match = matches[0];
    if (match) used.add(match);
    return {
      ...child,
      ...(match ? { worktreeBranch: match.branch } : {}),
      worktreeState: {
        availability: match && identity ? WorktreeAvailability.VALID : WorktreeAvailability.MISSING,
        identity: match?.identity ?? child.worktreeState?.identity ?? identity ?? null,
      },
    };
  });
  return { updates, additions: candidates.filter(candidate => !used.has(candidate)) };
}

