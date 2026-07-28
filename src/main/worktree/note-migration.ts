import type { Connector } from '../connector/types';
import { normalizeCwd, shellSingleQuote as q } from '../connector/file-utils';
import { listFeatureNotes } from './feature-notes';

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

function normalizeNotePaths(notePaths: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const rels: string[] = [];
  for (const notePath of notePaths) {
    const rel = notePath?.trim();
    if (!rel || seen.has(rel)) continue;
    assertRelativeSafe(rel);
    seen.add(rel);
    rels.push(rel);
  }
  return rels;
}

function notePair(baseRoot: string, worktreeRoot: string, rel: string): { src: string; dest: string } {
  return {
    src: `${baseRoot}/${rel}`,
    dest: `${worktreeRoot}/${rel}`,
  };
}

async function restoreBaseCopies(
  connector: Pick<Connector, 'exec'>,
  baseCwd: string,
  worktreeCwd: string,
  rels: readonly string[],
): Promise<void> {
  const baseRoot = normalizeCwd(baseCwd);
  const worktreeRoot = normalizeCwd(worktreeCwd);

  for (const rel of rels) {
    const { src, dest } = notePair(baseRoot, worktreeRoot, rel);
    const check = await connector.exec(baseCwd, `test -f ${q(src)} && echo ${OK} || echo ${MISSING}`);
    if (check.stdout.includes(OK)) continue;
    const srcParent = src.slice(0, src.lastIndexOf('/')) || '/';
    await connector.exec(baseCwd, `mkdir -p ${q(srcParent)} && cp ${q(dest)} ${q(src)}`);
  }
}

export async function migrateFeatureNotes(
  connector: Pick<Connector, 'exec'>,
  baseCwd: string,
  worktreeCwd: string,
  notePaths: readonly string[],
): Promise<NoteMigrationResult> {
  const rels = normalizeNotePaths(notePaths);
  // No notes bound — a valid degenerate case (fresh agent with no seed note).
  if (rels.length === 0) return { migrated: false };

  const baseRoot = normalizeCwd(baseCwd);
  const worktreeRoot = normalizeCwd(worktreeCwd);

  // Source checks are completed before any copy so a missing later note cannot
  // leave earlier notes half-migrated.
  for (const rel of rels) {
    const { src } = notePair(baseRoot, worktreeRoot, rel);
    const check = await connector.exec(baseCwd, `test -f ${q(src)} && echo ${OK} || echo ${MISSING}`);
    if (!check.stdout.includes(OK)) {
      throw new Error(`feature note not found at base: ${rel}`);
    }
  }

  const copied: string[] = [];
  try {
    for (const rel of rels) {
      const { src, dest } = notePair(baseRoot, worktreeRoot, rel);
      const destParent = dest.slice(0, dest.lastIndexOf('/')) || '/';
      await connector.exec(worktreeCwd, `mkdir -p ${q(destParent)} && cp ${q(src)} ${q(dest)}`);
      copied.push(rel);

      const verify = await connector.exec(worktreeCwd, `test -f ${q(dest)} && echo ${OK} || echo ${MISSING}`);
      if (!verify.stdout.includes(OK)) {
        throw new Error(`feature note copy failed (source kept): ${rel}`);
      }
    }
  } catch (err) {
    if (copied.length > 0) {
      const dests = copied.map((rel) => q(notePair(baseRoot, worktreeRoot, rel).dest)).join(' ');
      await connector.exec(worktreeCwd, `rm -f ${dests}`);
    }
    throw err;
  }

  try {
    const sources = rels.map((rel) => q(notePair(baseRoot, worktreeRoot, rel).src)).join(' ');
    await connector.exec(baseCwd, `rm -f ${sources}`);
  } catch (err) {
    await restoreBaseCopies(connector, baseCwd, worktreeCwd, rels);
    throw err;
  }

  return { migrated: true };
}

export async function migrateFeatureNote(
  connector: Pick<Connector, 'exec'>,
  baseCwd: string,
  worktreeCwd: string,
  notePath: string | undefined,
): Promise<NoteMigrationResult> {
  return migrateFeatureNotes(connector, baseCwd, worktreeCwd, notePath ? [notePath] : []);
}

/**
 * Reverse migration for worktree close: move any remaining transient feature
 * notes from the child worktree back to the base checkout before teardown.
 *
 * Missing child notes are normal: development-flow wrap-up may already have
 * consolidated and deleted the note. Existing base destinations are fail-loud so
 * close never overwrites unrelated base notes.
 */
export async function restoreFeatureNotes(
  connector: Pick<Connector, 'exec'>,
  baseCwd: string,
  worktreeCwd: string,
): Promise<NoteMigrationResult> {
  const notes = await listFeatureNotes(connector, worktreeCwd);
  if (notes.length === 0) return { migrated: false };

  const baseRoot = normalizeCwd(baseCwd);
  const worktreeRoot = normalizeCwd(worktreeCwd);

  for (const note of notes) {
    const rel = note.path.trim();
    assertRelativeSafe(rel);

    const src = `${worktreeRoot}/${rel}`;
    const dest = `${baseRoot}/${rel}`;

    const destFree = await connector.exec(baseCwd, `test ! -e ${q(dest)} && echo ${OK} || echo ${MISSING}`);
    if (!destFree.stdout.includes(OK)) {
      throw new Error(`feature note restore target already exists in base: ${rel}`);
    }

    const destParent = dest.slice(0, dest.lastIndexOf('/')) || '/';
    await connector.exec(worktreeCwd, `mkdir -p ${q(destParent)} && cp ${q(src)} ${q(dest)}`);

    const verify = await connector.exec(baseCwd, `test -f ${q(dest)} && echo ${OK} || echo ${MISSING}`);
    if (!verify.stdout.includes(OK)) {
      throw new Error(`feature note restore failed (source kept): ${rel}`);
    }

    await connector.exec(worktreeCwd, `rm -f ${q(src)}`);
  }

  return { migrated: true };
}
