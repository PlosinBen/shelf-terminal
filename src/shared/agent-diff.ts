/** Provider-neutral File Diff body. Legacy string diffs remain readable. */
export interface AgentDiffHunk {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
}

export type AgentDiff =
  | { oldString: string; newString: string }
  | { hunks: AgentDiffHunk[] };

export const AGENT_DIFF_ERROR = 'Invalid file diff data';

export type AgentDiffResult =
  | { ok: true; diff: AgentDiff }
  | { ok: false; reason: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function lines(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(line => typeof line === 'string' && !/[\r\n]/.test(line));
}

/** Validates the entire body; callers must make an invalid body fail-visible. */
export function readAgentDiff(value: unknown): AgentDiffResult {
  const diff = record(value);
  if (!diff) return { ok: false, reason: 'invalid-body' };
  if (!('hunks' in diff)) {
    return typeof diff.oldString === 'string' && typeof diff.newString === 'string'
      ? { ok: true, diff: { oldString: diff.oldString, newString: diff.newString } }
      : { ok: false, reason: 'invalid-strings' };
  }
  if ('oldString' in diff || 'newString' in diff) return { ok: false, reason: 'mixed-formats' };
  if (!Array.isArray(diff.hunks) || diff.hunks.length === 0) return { ok: false, reason: 'empty-hunks' };
  const hunks: AgentDiffHunk[] = [];
  let previousOldEnd: number | undefined;
  let previousNewEnd: number | undefined;
  for (const raw of diff.hunks) {
    const hunk = record(raw);
    if (!hunk || !lines(hunk.oldLines) || !lines(hunk.newLines)) return { ok: false, reason: 'invalid-lines' };
    const { oldStart, newStart, oldLines, newLines } = hunk;
    if (typeof oldStart !== 'number' || typeof newStart !== 'number'
      || !Number.isSafeInteger(oldStart) || !Number.isSafeInteger(newStart)
      || oldStart < (oldLines.length ? 1 : 0) || newStart < (newLines.length ? 1 : 0)
      || (oldLines.length === 0 && newLines.length === 0)) return { ok: false, reason: 'invalid-range' };
    const oldOffset = oldStart - (oldLines.length ? 1 : 0);
    const newOffset = newStart - (newLines.length ? 1 : 0);
    const oldEnd = oldOffset + oldLines.length;
    const newEnd = newOffset + newLines.length;
    if (!Number.isSafeInteger(oldEnd) || !Number.isSafeInteger(newEnd)) return { ok: false, reason: 'invalid-range' };
    if (previousOldEnd !== undefined && previousNewEnd !== undefined
      && (oldOffset < previousOldEnd || newOffset < previousNewEnd
        || oldOffset - previousOldEnd !== newOffset - previousNewEnd)) {
      return { ok: false, reason: 'inconsistent-hunk-ranges' };
    }
    hunks.push({ oldStart, newStart, oldLines: [...oldLines], newLines: [...newLines] });
    previousOldEnd = oldEnd;
    previousNewEnd = newEnd;
  }
  return { ok: true, diff: { hunks } };
}
