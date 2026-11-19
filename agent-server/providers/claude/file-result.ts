import { readAgentDiff, type AgentDiff } from '@shared/agent-diff';

export const CLAUDE_FILE_LABEL = { READ: 'Read file', EDIT: 'Edit file', CREATE: 'Create file', WRITE: 'Write' } as const;

type FileResult = { label: string; content?: string; diff?: AgentDiff; anomaly?: string };

/** SDK output is unknown on the wire. Validate before replacing input previews. */
export function readClaudeFileResult(value: unknown, path: string, write: boolean): FileResult | undefined {
  if (value === undefined) return undefined;
  const invalid = (anomaly: string): FileResult => ({ label: write ? CLAUDE_FILE_LABEL.WRITE : CLAUDE_FILE_LABEL.EDIT, anomaly });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('invalid-result');
  const data = value as Record<string, unknown>;
  if (data.filePath !== path) return invalid('path-mismatch');
  if (write && (data.type !== 'create' && data.type !== 'update' || typeof data.content !== 'string')) return invalid('invalid-write');
  if (!write && (typeof data.oldString !== 'string' || typeof data.newString !== 'string')) return invalid('invalid-edit');
  const result: FileResult = write
    ? { label: data.type === 'create' ? CLAUDE_FILE_LABEL.CREATE : CLAUDE_FILE_LABEL.EDIT, content: data.content as string }
    : { label: CLAUDE_FILE_LABEL.EDIT, diff: { oldString: data.oldString as string, newString: data.newString as string } };
  if (!Array.isArray(data.structuredPatch)) return { ...result, anomaly: 'invalid-patch' };
  if (!data.structuredPatch.length) return result;
  const hunks = [];
  for (const patch of data.structuredPatch) {
    if (!patch || !Array.isArray(patch.lines) || !patch.lines.every((line: unknown) => typeof line === 'string' && /^[ +\-]/.test(line))) {
      return { ...result, anomaly: 'invalid-patch-lines' };
    }
    const oldLines = (patch.lines as string[]).filter(line => line[0] !== '+').map(line => line.slice(1));
    const newLines = (patch.lines as string[]).filter(line => line[0] !== '-').map(line => line.slice(1));
    if (oldLines.length !== patch.oldLines || newLines.length !== patch.newLines) return { ...result, anomaly: 'patch-count-mismatch' };
    hunks.push({ oldStart: patch.oldStart, newStart: patch.newStart, oldLines, newLines });
  }
  const parsed = readAgentDiff({ hunks });
  return parsed.ok ? { label: result.label, diff: parsed.diff } : { ...result, anomaly: parsed.reason };
}
