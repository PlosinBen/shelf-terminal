export const WorktreeAvailability = { VALID: 'valid', MISSING: 'missing' } as const;
export const WorktreeScanOutcome = { APPLIED: 'applied', SKIPPED: 'skipped', STALE: 'stale' } as const;
export interface WorktreeIdentity {
  readonly checkoutPath: string;
  readonly gitDir: string;
  readonly commonDir: string;
}
export interface WorktreeState {
  readonly availability: typeof WorktreeAvailability[keyof typeof WorktreeAvailability];
  readonly identity: WorktreeIdentity | null;
}
export function isWorktreeUnavailable(project: { parentProjectId?: string | null; worktreeState?: WorktreeState | null }): boolean {
  return !!project.parentProjectId && project.worktreeState?.availability === WorktreeAvailability.MISSING;
}
export function worktreeLabel(project: { cwd: string; worktreeBranch?: string | null }): string {
  return project.worktreeBranch || `${project.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()} (detached)`;
}
