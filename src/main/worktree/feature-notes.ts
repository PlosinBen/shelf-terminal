import type { Connector } from '../connector/types';
import type { FeatureNoteInfo } from '@shared/types';

/**
 * List the in-progress feature notes under a repo's `.agent/features/` so the
 * worktree create dialog can offer them in a note-picker.
 *
 * Only notes whose frontmatter `status` is `in-progress` are surfaced — the
 * resumable set, matching feature-dev-flow (cancelled / malformed / the reserved
 * `index.md` which has no frontmatter are all dropped). Goes through the
 * connector shell (not node fs) so it works across local / SSH / Docker / WSL;
 * paths come back relative to the base cwd so they feed `migrateNote` directly.
 */

const MARKER = /^===SHELF_NOTE:(.*)===$/;

// One exec: for each feature note (skipping the reserved index.md), print a
// delimiter carrying its relative path, then the first 40 lines (enough to cover
// the YAML frontmatter). Parsed in JS — robust YAML-ish parsing beats a fragile
// remote shell one-liner. The glob is guarded by `[ -f ]` so zero matches → the
// literal pattern is skipped and the output is empty.
const LIST_CMD =
  'for f in .agent/features/*.md; do ' +
  '[ -f "$f" ] || continue; ' +
  'case "$f" in */index.md) continue;; esac; ' +
  "printf '===SHELF_NOTE:%s===\\n' \"$f\"; " +
  "sed -n '1,40p' \"$f\"; " +
  'done';

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
 * Pure: turn the delimited shell dump into the in-progress feature notes.
 * Exported for unit testing without a connector.
 */
export function parseFeatureNoteList(raw: string): FeatureNoteInfo[] {
  const notes: FeatureNoteInfo[] = [];
  let current: string | null = null;
  let block: string[] = [];

  const flush = () => {
    if (current === null) return;
    const fm = parseFrontmatter(block);
    if (fm.status === 'in-progress') {
      notes.push(fm.title ? { path: current, title: fm.title } : { path: current });
    }
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
): Promise<FeatureNoteInfo[]> {
  const { stdout } = await connector.exec(baseCwd, LIST_CMD);
  return parseFeatureNoteList(stdout);
}
