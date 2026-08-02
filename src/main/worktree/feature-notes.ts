import type { Connector } from '../connector/types';
import { normalizeCwd, shellSingleQuote as q } from '../connector/file-utils';
import { normalizeFeatureNoteDir } from '@shared/feature-note-dir';
import type { FeatureNoteInfo, FeatureNoteListResult } from '@shared/types';

/**
 * List the feature notes under a project's configured directory so the
 * worktree create dialog can offer them in a note-picker.
 *
 * ALL notes are surfaced regardless of frontmatter `status` — the user picks
 * which note seeds the worktree, so the app must not gatekeep (a paused/pending
 * note is just as pickable as an in-progress one). `status` (and `title`) are
 * parsed only to SHOW alongside each note, not to filter. The one exclusion is
 * the reserved `index.md`. Goes through the connector shell (not node fs) so it
 * works across local / SSH / Docker / WSL; paths come back relative to the base
 * cwd so they feed `migrateNote` directly.
 */

const MARKER = /^===SHELF_NOTE:(.*)===$/;

// One exec: resolve the configured directory against the connector cwd, reject
// symlink escape, then print each direct markdown child's path and frontmatter.
// Missing directories deliberately exit successfully with no output.
export function buildFeatureNoteListCommand(baseCwd: string, featureNoteDir: string): string {
  const root = normalizeCwd(baseCwd);
  return (
    `root_input=${q(root)}; rel_dir=${q(featureNoteDir)}; ` +
    'root=$(cd "$root_input" 2>/dev/null && pwd -P) || { echo "Unable to access project root: $root_input" >&2; exit 1; }; ' +
    'dir="$root/$rel_dir"; ' +
    '[ -e "$dir" ] || [ -L "$dir" ] || exit 0; ' +
    'resolved_dir=$(cd "$dir" 2>/dev/null && pwd -P) || { echo "Unable to access configured feature note directory: $dir" >&2; exit 1; }; ' +
    'case "$resolved_dir" in "$root"|"$root"/*) ;; *) echo "Configured feature note directory escapes project root: $dir" >&2; exit 1;; esac; ' +
    'for f in "$dir"/*.md; do ' +
    '[ -f "$f" ] || continue; ' +
    'case "$f" in */index.md) continue;; esac; ' +
    'if [ -L "$f" ]; then ' +
    'command -v realpath >/dev/null 2>&1 || { echo "Cannot validate feature note symlink without realpath: $f" >&2; exit 1; }; ' +
    'resolved_file=$(realpath "$f") || { echo "Unable to resolve feature note: $f" >&2; exit 1; }; ' +
    'case "$resolved_file" in "$root"|"$root"/*) ;; *) echo "Feature note escapes project root: $f" >&2; exit 1;; esac; ' +
    'fi; ' +
    "printf '===SHELF_NOTE:%s===\\n' \"${rel_dir}/${f##*/}\"; " +
    "sed -n '1,40p' \"$f\"; " +
    'done'
  );
}

interface ParsedFrontmatter {
  type?: string;
  status?: string;
  title?: string;
}

/** Parse a note block's leading YAML frontmatter (between the first two `---`). */
function parseFrontmatter(lines: string[]): ParsedFrontmatter {
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (lines[i]?.trim() !== '---') return {};
  i++;
  const fm: ParsedFrontmatter = {};
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key === 'type') fm.type = val;
    else if (key === 'status') fm.status = val;
    else if (key === 'title') fm.title = val;
  }
  return fm;
}

/**
 * Pure: turn the delimited shell dump into the feature notes (ALL of them, with
 * their title/status for display). Exported for unit testing without a connector.
 */
export function parseFeatureNoteList(raw: string): FeatureNoteInfo[] {
  const notes: FeatureNoteInfo[] = [];
  let current: string | null = null;
  let block: string[] = [];

  const flush = () => {
    if (current === null) return;
    const fm = parseFrontmatter(block);
    const note: FeatureNoteInfo = { path: current };
    if (fm.title) note.title = fm.title;
    if (fm.status) note.status = fm.status;
    notes.push(note);
  };

  for (const line of raw.split('\n')) {
    const m = MARKER.exec(line);
    if (m) {
      flush();
      current = m[1];
      block = [];
    } else if (current !== null) {
      block.push(line);
    }
  }
  flush();
  return notes;
}

export async function listFeatureNotes(
  connector: Pick<Connector, 'exec'>,
  baseCwd: string,
  featureNoteDir: string,
): Promise<FeatureNoteListResult> {
  try {
    const normalizedDir = normalizeFeatureNoteDir(featureNoteDir);
    if (!normalizedDir) {
      return { ok: false, error: 'Feature note directory is not configured' };
    }
    const { stdout } = await connector.exec(
      baseCwd,
      buildFeatureNoteListCommand(baseCwd, normalizedDir),
    );
    const notes = parseFeatureNoteList(stdout);
    const expectedPrefix = `${normalizedDir}/`;
    if (notes.some((note) => !note.path.startsWith(expectedPrefix))) {
      return { ok: false, error: 'Feature note listing returned a path outside the configured directory' };
    }
    return { ok: true, notes };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
