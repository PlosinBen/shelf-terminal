import type { Connector } from '../connector/types';
import { normalizeCwd, shellSingleQuote as q } from '../connector/file-utils';

/**
 * Feature-note migration for worktree create (the user-initiated New Worktree
 * dialog picks which note to carry).
 *
 * When a worktree is cut, the Phase-0 note that seeded the feature must land in
 * the new worktree BEFORE the fresh agent boots and reads it — so migration is
 * bound into the create transaction (not an agent-side `cp` afterwards), keeping
 * the "note in place before the agent boots" ordering race-free.
 *
 * Strategy = copy-then-delete-on-success: copy the note into the worktree at the
 * SAME relative position, verify it landed, only then delete the base copy. A
 * copy failure keeps the source (no half-move where both sides lose it); a
 * given-but-missing path is fail-loud (never create an empty note).
 *
 * Goes through the connector's shell (not node fs) so it works uniformly across
 * local / SSH / Docker / WSL. `notePath` is relative to the base cwd — relative,
 * never absolute, keeps it connection-agnostic.
 */

// Sentinels for existence probes — echoed by the remote shell so a missing file
// is a normal stdout result, not an exec rejection (which would blur the reason).
const OK = '__SHELF_NOTE_OK__';
const MISSING = '__SHELF_NOTE_MISSING__';

export interface NoteMigrationResult {
  /** true = a note was actually moved; false = no note was bound (degenerate, allowed). */
  migrated: boolean;
}

/** Reject absolute paths and parent traversal — the note must stay within cwd. */
function assertRelativeSafe(notePath: string): void {
  if (notePath.startsWith('/')) {
    throw new Error(`notePath must be relative to the base cwd, got absolute: ${notePath}`);
  }
  if (notePath.split('/').some((seg) => seg === '..')) {
    throw new Error(`notePath must not traverse parent directories: ${notePath}`);
  }
}

export async function migrateFeatureNote(
  connector: Pick<Connector, 'exec'>,
  baseCwd: string,
  worktreeCwd: string,
  notePath: string | undefined,
): Promise<NoteMigrationResult> {
  const rel = notePath?.trim();
  // No note bound — a valid degenerate case (fresh agent with no seed note).
  if (!rel) return { migrated: false };

  assertRelativeSafe(rel);

  const src = `${normalizeCwd(baseCwd)}/${rel}`;
  const dest = `${normalizeCwd(worktreeCwd)}/${rel}`;

  // 1. Source must exist. Given-but-missing = fail-loud; never fabricate an empty note.
  const check = await connector.exec(baseCwd, `test -f ${q(src)} && echo ${OK} || echo ${MISSING}`);
  if (!check.stdout.includes(OK)) {
    throw new Error(`feature note not found at base: ${rel}`);
  }

  // 2. Copy into the worktree at the same relative position (mkdir parents first).
  const destParent = dest.slice(0, dest.lastIndexOf('/')) || '/';
  await connector.exec(worktreeCwd, `mkdir -p ${q(destParent)} && cp ${q(src)} ${q(dest)}`);

  // 3. Verify the copy landed BEFORE touching the source (copy-then-delete-on-success).
  const verify = await connector.exec(worktreeCwd, `test -f ${q(dest)} && echo ${OK} || echo ${MISSING}`);
  if (!verify.stdout.includes(OK)) {
    // Copy did not land — keep the source so nothing is lost.
    throw new Error(`feature note copy failed (source kept): ${rel}`);
  }

  // 4. Copy confirmed — remove the base copy so no orphan lingers.
  await connector.exec(baseCwd, `rm -f ${q(src)}`);

  return { migrated: true };
}
