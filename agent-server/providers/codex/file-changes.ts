import { createHash } from 'node:crypto';
import { readAgentDiff, type AgentDiffHunk } from '@shared/agent-diff';
import type { OutgoingMessage } from '../types';

const CHANGE_KIND = { UPDATE: 'update', ADD: 'add', DELETE: 'delete' } as const;
const CARD_ID_PREFIX = 'codex-file-change:';
const ANOMALY_ID_PREFIX = 'codex-file-change-anomaly:';
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

export interface FileChangeDiagnostic {
  itemId: string;
  path?: string;
  index?: number;
  reason: string;
  level: 'debug' | 'warn';
}

type ParseResult =
  | { ok: true; hunks: AgentDiffHunk[] }
  | { ok: false; reason: string; level: 'debug' | 'warn' };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Parse complete unified hunks only, never streaming apply_patch fragments. */
export function parseFileChangeDiff(diff: string): ParseResult {
  if (diff.includes('\r') || diff.split('\n').includes(NO_NEWLINE_MARKER)) {
    return { ok: false, reason: 'unsupported-line-endings', level: 'debug' };
  }
  if (!diff) return { ok: false, reason: 'empty-diff', level: 'debug' };
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let index = 0;
  if (lines[0]?.startsWith('--- ') && lines[1]?.startsWith('+++ ')) index = 2;
  const hunks: AgentDiffHunk[] = [];
  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[index++]);
    if (!header) return { ok: false, reason: 'invalid-hunk-header', level: 'warn' };
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2] ?? 1);
    const newStart = Number(header[3]);
    const newCount = Number(header[4] ?? 1);
    if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) {
      return { ok: false, reason: 'invalid-hunk-range', level: 'warn' };
    }
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let changed = false;
    while (index < lines.length && !lines[index].startsWith('@@')) {
      const line = lines[index++];
      switch (line[0]) {
        case ' ': oldLines.push(line.slice(1)); newLines.push(line.slice(1)); break;
        case '-': oldLines.push(line.slice(1)); changed = true; break;
        case '+': newLines.push(line.slice(1)); changed = true; break;
        default: return { ok: false, reason: 'invalid-hunk-line', level: 'warn' };
      }
      if (oldLines.length > oldCount || newLines.length > newCount) {
        return { ok: false, reason: 'hunk-count-mismatch', level: 'warn' };
      }
    }
    if (!changed || oldLines.length !== oldCount || newLines.length !== newCount) {
      return { ok: false, reason: 'hunk-count-mismatch', level: 'warn' };
    }
    hunks.push({ oldStart, newStart, oldLines, newLines });
  }
  const checked = readAgentDiff({ hunks });
  return checked.ok ? { ok: true, hunks } : { ok: false, reason: checked.reason, level: 'warn' };
}

function cardId(prefix: string, itemId: string, key: string | number): string {
  return prefix + createHash('sha256').update(JSON.stringify([itemId, key])).digest('hex');
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '(missing)';
}

/** A source file may itself contain Markdown fences. Preserve it as code. */
function fence(content: string, language = ''): string {
  const length = Math.max(3, ...Array.from(content.matchAll(/`+/g), match => match[0].length + 1));
  const marker = '`'.repeat(length);
  return `${marker}${language}\n${content}\n${marker}`;
}

export function fileChangesToMessages(
  itemId: string,
  item: Record<string, unknown>,
): { messages: OutgoingMessage[]; diagnostics: FileChangeDiagnostic[] } {
  const messages: OutgoingMessage[] = [];
  const diagnostics: FileChangeDiagnostic[] = [];
  const error = item.status === 'failed' ? { errorMessage: 'File change failed' }
    : item.status === 'declined' ? { errorMessage: 'File change declined' } : {};
  const base = { type: 'message' as const, label: 'File changes', ...error };
  const warn = (reason: string, index?: number, path?: string) => diagnostics.push({ itemId, reason, level: 'warn', index, path });
  const fallback = (msgId: string, content: string, path?: string) => {
    messages.push({ ...base, msgId, msgType: 'fold_markdown', ...(path ? { subtitle: path } : {}), body: { content } });
  };
  if (!Array.isArray(item.changes) || item.changes.length === 0) {
    warn(Array.isArray(item.changes) ? 'empty-changes' : 'invalid-changes');
    fallback(cardId(ANOMALY_ID_PREFIX, itemId, 'item'), Array.isArray(item.changes)
      ? 'No file changes were provided.' : `Invalid file changes:\n${fence(json(item.changes), 'json')}`);
    return { messages, diagnostics };
  }
  const groups = new Map<string, unknown[]>();
  for (const entry of item.changes) {
    const path = record(entry)?.path;
    if (typeof path === 'string' && path.trim()) groups.set(path, [...(groups.get(path) ?? []), entry]);
  }
  const emitted = new Set<string>();
  for (const [index, entry] of item.changes.entries()) {
    const change = record(entry);
    const path = change?.path;
    if (!change || typeof path !== 'string' || !path.trim()) {
      warn('missing-path', index);
      fallback(cardId(ANOMALY_ID_PREFIX, itemId, index), fence(json(entry), 'json'));
      continue;
    }
    if (emitted.has(path)) continue; // Duplicate entries are preserved together below.
    emitted.add(path);
    const msgId = cardId(CARD_ID_PREFIX, itemId, path);
    const duplicates = groups.get(path)!;
    if (duplicates.length > 1) {
      warn('duplicate-path', index, path);
      fallback(msgId, fence(json(duplicates), 'json'), path);
      continue;
    }
    const kind = record(change.kind);
    if (!kind || !Object.values(CHANGE_KIND).includes(kind.type as typeof CHANGE_KIND[keyof typeof CHANGE_KIND])
      || typeof change.diff !== 'string') {
      warn('invalid-change', index, path);
      fallback(msgId, fence(json(change), 'json'), path);
      continue;
    }
    if (kind.type === CHANGE_KIND.UPDATE && kind.move_path == null) {
      const parsed = parseFileChangeDiff(change.diff);
      if (parsed.ok) {
        messages.push({ ...base, msgId, msgType: 'fold_diff', subtitle: path, body: { diff: { hunks: parsed.hunks } } });
        continue;
      }
      diagnostics.push({ itemId, path, index, reason: parsed.reason, level: parsed.level });
    } else {
      diagnostics.push({ itemId, path, index, reason: 'unsupported-change-kind', level: 'debug' });
    }
    fallback(msgId, `${fence(json(kind), 'json')}\n\n${fence(change.diff, 'diff')}`, path);
  }
  return { messages, diagnostics };
}
