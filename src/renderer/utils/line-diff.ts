// Line-level LCS diff for the Edit tool's side-by-side view.
// Output rows align left (old) and right (new); adjacent del+add are
// collapsed into a single 'change' row so visually corresponding edits
// land on the same horizontal line.

export type DiffRowKind = 'same' | 'del' | 'add' | 'change';

export interface DiffRow {
  kind: DiffRowKind;
  old: string | null;
  new: string | null;
}

export function alignLineDiff(oldLines: string[], newLines: string[]): DiffRow[] {
  const m = oldLines.length;
  const n = newLines.length;

  // LCS DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce raw rows
  const raw: DiffRow[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      raw.unshift({ kind: 'same', old: oldLines[i - 1], new: newLines[j - 1] });
      i--;
      j--;
    } else if (dp[i][j - 1] >= dp[i - 1][j]) {
      // Tie-breaks toward add (j--) so that, walking the backtrack from end to
      // start with unshift, the resulting forward order is del-then-add — which
      // the post-pass can pair into 'change' rows.
      raw.unshift({ kind: 'add', old: null, new: newLines[j - 1] });
      j--;
    } else {
      raw.unshift({ kind: 'del', old: oldLines[i - 1], new: null });
      i--;
    }
  }
  while (i > 0) { raw.unshift({ kind: 'del', old: oldLines[i - 1], new: null }); i--; }
  while (j > 0) { raw.unshift({ kind: 'add', old: null, new: newLines[j - 1] }); j--; }

  // Pair adjacent del→add into a single 'change' row so the visual diff
  // looks like GitHub's side-by-side rather than two stacked monocolour blocks.
  const out: DiffRow[] = [];
  for (let k = 0; k < raw.length; k++) {
    const cur = raw[k];
    const next = raw[k + 1];
    if (cur.kind === 'del' && next?.kind === 'add') {
      out.push({ kind: 'change', old: cur.old, new: next.new });
      k++;
    } else {
      out.push(cur);
    }
  }
  return out;
}
