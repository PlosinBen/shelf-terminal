// Pure helpers extracted from claude.ts (P0-1 architecture-health refactor).
// SDK wiring, the backend closure (createClaudeBackend), and processMessage
// stay in claude.ts — this module holds only side-effect-free mappers/parsers
// and the small data types they share with the backend.
import type { StatusSegment, SendFn } from '../types';
import { severityFromUtilization, formatResetCountdown } from '../types';
import type { ProviderModel, NormalizedTask, TaskEventKind } from '@shared/types';
import { stripCwd } from '../shared';

const RATE_LIMIT_LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d-opus',
  seven_day_sonnet: '7d-sonnet',
  overage: 'overage',
};

/**
 * Convert Claude's `SDKRateLimitInfo` to a `StatusSegment`.
 *
 * Two SDK quirks we work around:
 * 1. `utilization` is only populated when `status === 'allowed_warning' | 'rejected'` —
 *    on `'allowed'` it is silently dropped even though the underlying
 *    `anthropic-ratelimit-unified-*-utilization` headers always carry it.
 *    We render `5h: — ↻3h` so the bucket + countdown are still visible.
 * 2. `resetsAt` is a Unix timestamp in *seconds*, but `formatResetCountdown`
 *    expects milliseconds — multiply by 1000.
 *
 * Returns `null` when there is nothing useful to display.
 */
export function rateLimitInfoToSegment(info: any): StatusSegment | null {
  if (!info) return null;

  const label = RATE_LIMIT_LABELS[info.rateLimitType] ?? info.rateLimitType ?? 'quota';
  const hasPct = typeof info.utilization === 'number';
  const pctText = hasPct ? `${Math.round(info.utilization * 100)}%` : '—';
  const reset = typeof info.resetsAt === 'number'
    ? formatResetCountdown(info.resetsAt * 1000)
    : null;

  // 'rejected' = hard cap; 'allowed_warning' = SDK-flagged warning. Severity
  // from utilization only kicks in on 'allowed' when we actually have a number.
  const severity: StatusSegment['severity'] = info.status === 'rejected'
    ? 'critical'
    : info.status === 'allowed_warning'
      ? 'warning'
      : hasPct
        ? severityFromUtilization(info.utilization)
        : 'normal';

  return {
    text: `${label}: ${pctText}${reset ? ` ↻${reset}` : ''}`,
    severity,
  };
}

/** Sample of a preview field carried on an AskUserQuestion option. Logged by
 * the runtime caller — v1 picker UI doesn't render preview content yet
 * (v1 doesn't render preview content — see agent-ui#3 "Out of scope"). */
export interface AskUserQuestionPreviewSample {
  question: string;
  optionLabel: string;
  previewLength: number;
  preview: string;
}

/** Output of `askUserQuestionToPrompts` — picker_request `prompts[]` plus
 * the original `questions` array (kept for the answer-JSON builder) plus
 * any preview samples the caller should log. */
export interface AskUserQuestionMapped {
  questions: Array<{ question: string; [k: string]: unknown }>;
  prompts: Array<{
    question: string;
    header?: string;
    multiSelect: boolean;
    options: Array<{ label: string; description?: string; preview?: string }>;
    inputType: 'text';
  }>;
  previewSamples: AskUserQuestionPreviewSample[];
}

/**
 * Pure mapper: AskUserQuestionInput → picker_request `prompts[]`.
 *
 * Returns `null` for malformed input (no questions array, or empty). Caller
 * uses that as the signal to reject the tool call with an explanatory deny
 * rather than emit an empty picker.
 *
 * `inputType: 'text'` is hardcoded — AskUserQuestion's spec auto-adds an
 * "Other" option to every question (sdk-tools.d.ts comment on `options`),
 * so the picker must always offer free-text entry alongside the listed
 * options.
 */
export function askUserQuestionToPrompts(input: Record<string, unknown>): AskUserQuestionMapped | null {
  const questions = Array.isArray((input as any)?.questions) ? (input as any).questions : null;
  if (!questions || questions.length === 0) return null;

  const previewSamples: AskUserQuestionPreviewSample[] = [];
  const prompts = questions.map((q: any) => {
    const options = Array.isArray(q?.options) ? q.options : [];
    for (const opt of options) {
      if (typeof opt?.preview === 'string' && opt.preview.length > 0) {
        previewSamples.push({
          question: String(q?.question ?? ''),
          optionLabel: String(opt?.label ?? ''),
          previewLength: opt.preview.length,
          preview: opt.preview,
        });
      }
    }
    return {
      question: String(q?.question ?? ''),
      header: typeof q?.header === 'string' ? q.header : undefined,
      multiSelect: !!q?.multiSelect,
      options: options.map((o: any) => ({
        label: String(o?.label ?? ''),
        description: typeof o?.description === 'string' ? o.description : undefined,
        preview: typeof o?.preview === 'string' ? o.preview : undefined,
      })),
      inputType: 'text' as const,
    };
  });

  return { questions, prompts, previewSamples };
}

/**
 * Pure builder: PickerResolvePayload answers → AskUserQuestionOutput JSON.
 *
 * Output shape per SDK spec (sdk-tools.d.ts:2530 AskUserQuestionOutput):
 *   { questions: [...echo], answers: { [questionText]: string } }
 *
 * Multi-select answers are comma-joined per SDK spec comment line 2688
 * ("multi-select answers are comma-separated"). `annotations` is omitted —
 * it's optional in the SDK schema, and we don't surface preview/notes in
 * v1 UI so there's nothing to echo back.
 */
export function buildAskUserQuestionAnswerJson(
  questions: Array<{ question: string; [k: string]: unknown }>,
  answers: Array<string | string[]>,
): string {
  const answersMap: Record<string, string> = {};
  questions.forEach((q, i) => {
    const ans = answers[i];
    answersMap[q.question] = Array.isArray(ans) ? ans.join(', ') : String(ans ?? '');
  });
  return JSON.stringify({ questions, answers: answersMap });
}

/**
 * Decide whether a per-turn SDK-resolved model id should replace the user's
 * current model selection (and thus overwrite status bar + project config).
 *
 * Rule (see agent-config-flow#4):
 *   - currentModel is one of supportedModels()' recommended aliases
 *     (default/sonnet/haiku) → DON'T adopt; the alias tracks the
 *     recommendation and must stay stable.
 *   - currentModel is anything else (user pinned a specific / custom id) →
 *     adopt the concrete model the SDK actually used.
 *
 * Defensive guards: skip synthetic models ('<...>'), no-op when unchanged,
 * skip when currentModel is unset (treated as alias-like / unpinned), and
 * skip when the alias list isn't populated yet (don't misclassify before
 * warmup completes).
 */
export function shouldAdoptResolvedModel(
  resolved: unknown,
  currentModel: string | undefined,
  aliases: { value: string }[],
): resolved is string {
  if (typeof resolved !== 'string') return false;
  if (resolved.startsWith('<')) return false;
  if (currentModel == null) return false;
  if (resolved === currentModel) return false;
  if (aliases.length === 0) return false;
  if (aliases.some((m) => m.value === currentModel)) return false;
  return true;
}

export function mergeClaudeModels(
  sdkModels: { value: string; displayName: string }[],
  customs?: ProviderModel[],
): { value: string; displayName: string; vision: boolean }[] {
  const result: { value: string; displayName: string; vision: boolean }[] = sdkModels.map((m) => ({
    value: m.value,
    displayName: m.displayName,
    vision: true,
  }));
  if (!customs || customs.length === 0) return result;
  const indexById = new Map(result.map((m, i) => [m.value, i]));
  for (const c of customs) {
    const entry = { value: c.id, displayName: c.id, vision: true };
    const existing = indexById.get(c.id);
    if (existing != null) {
      result[existing] = entry;
    } else {
      indexById.set(c.id, result.length);
      result.push(entry);
    }
  }
  return result;
}

/**
 * Unwrap a Claude SDK tool_result `content` payload into a plain string for
 * the renderer. SDK delivers it as either:
 *   - string (legacy / simple tools)
 *   - array of content blocks: `[{ type: 'text', text: '...' }, ...]` (Task /
 *     Agent sub-agent returns this shape; MCP tools may too)
 *   - (rare) other structured shapes — JSON-stringify as last resort
 *
 * Earlier code blindly `JSON.stringify`d the array form, surfacing
 * `[{"type":"text","text":"..."}]` to the user. Unwrap text blocks so the
 * renderer's <pre> shows readable output.
 */
export function extractToolResultText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const parts = raw.map((b) => {
      if (typeof b === 'string') return b;
      if (b && typeof b === 'object') {
        const block = b as { type?: string; text?: string };
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
      }
      return JSON.stringify(b);
    });
    return parts.join('\n');
  }
  return JSON.stringify(raw);
}

/**
 * Claude SDK wraps tool error content in `<tool_use_error>…</tool_use_error>`
 * tags. That wrapper is an SDK wire detail — strip it so the renderer shows
 * just the message (the red "Tool returned an error" banner already signals
 * it's an error). No-op when the wrapper is absent.
 */
export function stripToolErrorWrapper(content: string): string {
  const m = content.match(/^\s*<tool_use_error>([\s\S]*)<\/tool_use_error>\s*$/);
  return m ? m[1].trim() : content;
}

export type TaskRecord = {
  subject: string;
  description: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
};

/**
 * Parse `TaskCreate` tool_result to extract the SDK-assigned task id.
 *
 * Type def in `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` claims
 * `{ task: { id, subject } }`, but the actual wire content (verified empirically
 * on SDK 0.3.159 with model claude-opus-4-8) is human-readable text:
 *
 *   "Task #1 created successfully: Run typecheck"
 *
 * The `#N` integer is the taskId — TaskUpdate's `taskId` input matches it
 * verbatim (`"1"`, `"2"`, ...). Type-def-vs-runtime mismatch is documented
 * in `.agent/GOTCHAS.md`.
 *
 * Falls back to JSON shape just in case some flow returns the documented
 * structured form. Returns null when neither matches; caller drops the
 * pending entry and lets the next TaskList reconcile.
 */
export function parseTaskCreateOutput(content: string): string | null {
  // Wire format (observed): "Task #N created successfully: <subject>"
  const m = content.match(/^Task\s+#(\d+)\s+created\s+successfully/i);
  if (m) return m[1];
  // Documented JSON shape — kept as defensive fallback.
  try {
    const parsed = JSON.parse(content) as { task?: { id?: string | number } };
    const id = parsed?.task?.id;
    if (id != null) return String(id);
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Parse `TaskList` tool_result. Output shape:
 *   `{ tasks: Array<{ id, subject, status, owner? }> }`
 * Description and activeForm are NOT in TaskListOutput, so reconcile leaves
 * those fields empty when filling from a snapshot.
 */
export function parseTaskListOutput(content: string): Array<{
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
}> | null {
  try {
    const parsed = JSON.parse(content) as {
      tasks?: Array<{ id?: string; subject?: string; status?: string }>;
    };
    if (!Array.isArray(parsed?.tasks)) return null;
    const VALID_STATUS = new Set(['pending', 'in_progress', 'completed']);
    const out: Array<{ id: string; subject: string; status: TaskRecord['status'] }> = [];
    for (const t of parsed.tasks) {
      if (typeof t?.id !== 'string' || typeof t?.subject !== 'string') continue;
      if (typeof t?.status !== 'string' || !VALID_STATUS.has(t.status)) continue;
      out.push({ id: t.id, subject: t.subject, status: t.status as TaskRecord['status'] });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Render the tasks Map as a markdown checklist and emit to renderer as a
 * `plan` event. Renderer doesn't change; this replaces the old TodoWrite
 * snapshot path with the same wire shape.
 *
 *   pending      → `- [ ] subject`
 *   in_progress  → `- [~] activeForm` (or subject if activeForm absent)
 *   completed    → `- [x] subject`
 *
 * Insertion order of the Map drives row order — matches the order Agent
 * created tasks, which matches user mental model of "plan steps".
 */
export function renderPlan(send: SendFn, taskMap: Map<string, TaskRecord>) {
  const md = Array.from(taskMap.values()).map((t) => {
    if (t.status === 'completed') return `- [x] ${t.subject}`;
    if (t.status === 'in_progress') return `- [~] ${t.activeForm ?? t.subject}`;
    return `- [ ] ${t.subject}`;
  }).join('\n');
  send({ type: 'plan', content: md });
}

/**
 * Apply a TaskList snapshot to the local Map as drift-correction.
 *
 * Snapshot is server ground truth; possible local-vs-server divergences:
 *   - Local has id missing from snapshot → task deleted server-side, drop locally
 *   - Snapshot has id missing locally → resume-session or we missed a create,
 *     add with empty description/activeForm (TaskListOutput doesn't carry them)
 *   - Both have id but different status/subject → trust snapshot
 *
 * Always re-emits plan after applying so renderer sees the corrected state.
 */
export function reconcileTasks(
  taskMap: Map<string, TaskRecord>,
  snapshot: Array<{ id: string; subject: string; status: TaskRecord['status'] }>,
  send: SendFn,
) {
  const snapshotIds = new Set(snapshot.map((t) => t.id));
  for (const id of Array.from(taskMap.keys())) {
    if (!snapshotIds.has(id)) taskMap.delete(id);
  }
  for (const t of snapshot) {
    const existing = taskMap.get(t.id);
    if (existing) {
      taskMap.set(t.id, { ...existing, subject: t.subject, status: t.status });
    } else {
      taskMap.set(t.id, { subject: t.subject, description: '', status: t.status });
    }
  }
  renderPlan(send, taskMap);
}

/**
 * Format a Claude SDK tool's `input` object into a single human-readable
 * string for the renderer. Renderer treats the result as opaque text and only
 * does CSS truncation — all "what's the headline of this tool call" logic
 * lives here in the provider, where SDK semantics are already known.
 *
 * Falls back to JSON for unknown tools so MCP custom tools still display
 * something instead of a blank line.
 */
export function formatClaudeToolInput(toolName: string, input: Record<string, unknown>, cwd: string): string {
  switch (toolName) {
    case 'Bash':
      return String(input.command ?? '');
    case 'Read': {
      const fp = String(input.file_path ?? '');
      const off = input.offset != null ? Number(input.offset) : null;
      const lim = input.limit != null ? Number(input.limit) : null;
      const range = off != null || lim != null
        ? ` (${off ?? 0}${lim != null ? `..+${lim}` : ''})`
        : '';
      return stripCwd(fp, cwd) + range;
    }
    case 'Grep': {
      const pattern = String(input.pattern ?? '');
      const path = input.path ? ` in ${stripCwd(String(input.path), cwd)}` : '';
      return pattern + path;
    }
    case 'Glob': {
      const pattern = String(input.pattern ?? '');
      const path = input.path ? ` in ${stripCwd(String(input.path), cwd)}` : '';
      return pattern + path;
    }
    case 'WebFetch':
      return String(input.url ?? '');
    case 'WebSearch':
      return String(input.query ?? '');
    // Claude SDK uses both `Task` (older) and `Agent` (newer claude-code SDK)
    // for sub-agent dispatch. Same input shape: `{ description, subagent_type,
    // prompt }`. Treat them identically — header surfaces the human-friendly
    // description plus a prompt preview, not the whole prompt blob.
    case 'Task':
    case 'Agent': {
      const desc = input.description ?? input.subagent_type ?? '';
      const prompt = String(input.prompt ?? '');
      return desc ? `${desc}: ${prompt.slice(0, 80)}` : prompt.slice(0, 120);
    }
    default: {
      // Generic fallback: first string value if any (most SDK tools have one
      // dominant arg), else JSON.
      const firstStr = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      if (firstStr) return firstStr;
      return JSON.stringify(input);
    }
  }
}

// ── Background tasks ────────────────────────────────────────────────────────
// Pure mapper for the SDK's `task_*` system messages → NormalizedTask render
// primitives. State (the per-id Map, output-file stash, ambient set) lives in
// the backend closure; this fn is side-effect-free so it's unit-testable like
// the other parsers here. See background-tasks#2 (Phase 0
// confirmed the SDK shapes against a real backgrounded Bash).

/** SDK `task_type` → NormalizedTask.type. Unknown values collapse to 'unknown'
 *  (a backgrounded Bash is 'local_bash'; never leak SDK vocabulary). */
const BG_TASK_TYPE_MAP: Record<string, NormalizedTask['type']> = {
  local_bash: 'shell',
  shell: 'shell',
  subagent: 'subagent',
  // The SDK emits `local_agent` (not `subagent`) for a backgrounded Task-tool
  // subagent — confirmed live via scripts/spike-task-loggers.mjs. Without this
  // the card fell through to 'unknown'.
  local_agent: 'subagent',
  monitor: 'monitor',
  workflow: 'workflow',
  local_workflow: 'workflow',
};
/** SDK task status → NormalizedTask.status. SDK uses 'killed'/'paused' which our
 *  render primitive doesn't carry: killed→stopped, paused→running. */
const BG_STATUS_MAP: Record<string, NormalizedTask['status']> = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  killed: 'stopped',
  paused: 'running',
};
const TERMINAL_BG_STATUS = new Set<NormalizedTask['status']>(['completed', 'failed', 'stopped']);

function mapBgTaskType(t: unknown): NormalizedTask['type'] {
  return (typeof t === 'string' && BG_TASK_TYPE_MAP[t]) || 'unknown';
}
function mapBgStatus(s: unknown, fallback: NormalizedTask['status']): NormalizedTask['status'] {
  return (typeof s === 'string' && BG_STATUS_MAP[s]) || fallback;
}

export interface NormalizedTaskMessage {
  kind: TaskEventKind;
  task: NormalizedTask;
  /** Remote path to the task's full output (task_notification only) — stashed
   *  server-side for the M2 read_task_output RPC, never sent as a render primitive. */
  outputFile?: string;
  /** task_started.skip_transcript === true: ambient/housekeeping task to hide. */
  ambient?: boolean;
}

/**
 * Is this `task_started` actually a FOREGROUND (synchronous) Bash, not a real
 * background task? The SDK emits `task_started` for a slow SYNC Bash too (a fast
 * one doesn't — spike-confirmed, scripts/spike-sync-vs-bg.ts), and its
 * task_started is structurally identical to a backgrounded one
 * (`task_type: 'local_bash'`). The only reliable signal AT task_started time is
 * the spawning tool_use's `run_in_background` flag (the tool_use precedes
 * task_started in the stream, so the caller has recorded it by id). A foreground
 * Bash's terminal task_notification also has an empty `output_file`, but that's
 * too late to avoid showing a card — hence filtering here, at the start.
 *
 * Returns true ONLY when we KNOW it's a foreground Bash (tool_use seen with
 * run_in_background===false). Unknown tool_use → false (don't hide — safer to
 * show a stray card than to swallow a real background task). Non-`local_bash`
 * task types (subagents etc.) are never foreground-Bash → false.
 */
export function isForegroundBashTaskStart(
  msg: any,
  bgByToolUse: Map<string, boolean>,
): boolean {
  return msg?.subtype === 'task_started'
    && msg?.task_type === 'local_bash'
    && typeof msg?.tool_use_id === 'string'
    && bgByToolUse.get(msg.tool_use_id) === false;
}

/**
 * Map one claude SDK background-task system message into a NormalizedTask + event
 * kind, merging onto `prev` (previously-known state for this task_id, or
 * undefined). Returns null if `msg` isn't a task_* system message. PURE — the
 * caller owns the per-id Map and output-file stash. Phase 0 confirmed shapes:
 *   task_started      { task_id, description, task_type, tool_use_id, skip_transcript? }
 *   task_updated      { task_id, patch:{ status, error? } }
 *   task_progress     { task_id, summary? }
 *   task_notification { task_id, status, summary, output_file }
 */
export function normalizeTaskMessage(msg: any, prev?: NormalizedTask): NormalizedTaskMessage | null {
  if (msg?.type !== 'system' || typeof msg.subtype !== 'string') return null;
  const id = msg.task_id;
  if (typeof id !== 'string' || !id) return null;
  const base: NormalizedTask = prev ?? { id, type: 'unknown', label: id, status: 'running', done: false };

  switch (msg.subtype) {
    case 'task_started': {
      if (msg.skip_transcript === true) return { kind: 'started', task: base, ambient: true };
      return {
        kind: 'started',
        task: {
          id,
          type: mapBgTaskType(msg.task_type),
          label: typeof msg.description === 'string' ? msg.description : id,
          status: 'running',
          done: false,
        },
      };
    }
    case 'task_updated': {
      const status = mapBgStatus(msg.patch?.status, base.status);
      const done = TERMINAL_BG_STATUS.has(status);
      return {
        kind: done ? 'done' : 'updated',
        task: {
          ...base,
          status,
          error: typeof msg.patch?.error === 'string' ? msg.patch.error : base.error,
          done,
        },
      };
    }
    case 'task_progress':
      return {
        kind: 'progress',
        task: { ...base, summary: typeof msg.summary === 'string' ? msg.summary : base.summary },
      };
    case 'task_notification': {
      const status = mapBgStatus(msg.status, base.status);
      return {
        kind: 'done',
        task: {
          ...base,
          status,
          summary: typeof msg.summary === 'string' ? msg.summary : base.summary,
          done: TERMINAL_BG_STATUS.has(status),
        },
        outputFile: typeof msg.output_file === 'string' ? msg.output_file : undefined,
      };
    }
    default:
      return null;
  }
}

/**
 * Reconstruct the SDK's per-session task-output directory when the terminal
 * `task_notification` — the SOLE carrier of the exact `output_file` path — never
 * arrived for a task. That happens for tasks that settle mid-turn or when
 * several finish at once: a known upstream delivery bug where a task can settle
 * via `task_updated` with NO corresponding TaskNotificationMessage. Upstream refs
 * (canonical citation for this bug — other "upstream delivery bug" comments in
 * this provider point here):
 *   - https://github.com/anthropics/claude-code/issues/20754
 *       N tasks finishing at once → only ONE TaskNotificationMessage delivered.
 *       This is the core case we recover from.
 *   - https://github.com/anthropics/claude-code/issues/20525
 *   - https://github.com/anthropics/claude-code/issues/17011
 *   - https://github.com/anthropics/claude-agent-sdk-python/blob/main/CHANGELOG.md
 *       The SDK's own changelog admits a task can settle via `task_updated` with
 *       no TaskNotificationMessage.
 * The output file itself IS on disk at
 * `<base>/<project-slug>/<sessionId>/tasks/<id>.output`.
 *
 * The `<project-slug>` segment uses Claude's own path encoding (`/` AND `_` → `-`,
 * etc.) which we deliberately do NOT replicate — instead pick the slug whose
 * `<sessionId>/tasks` directory actually exists (the sessionId is unique, so at
 * most one matches). PURE: the caller supplies the candidate slug list + an
 * existence predicate, so it's unit-testable without touching the filesystem.
 */
export function pickSessionTasksDir(
  base: string,
  sessionId: string,
  slugs: string[],
  exists: (dir: string) => boolean,
): string | undefined {
  if (!base || !sessionId) return undefined;
  for (const slug of slugs) {
    const dir = `${base}/${slug}/${sessionId}/tasks`;
    if (exists(dir)) return dir;
  }
  return undefined;
}

