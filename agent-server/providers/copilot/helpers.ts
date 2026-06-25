// Pure helpers extracted from copilot.ts (P0-1 architecture-health refactor).
// SDK wiring, the backend closure (createCopilotBackend), and session/event
// handling stay in copilot.ts — this module holds only side-effect-free
// mappers/parsers and the small data types they share with the backend.
import type { StatusSegment } from '../types';
import { severityFromUtilization, formatResetCountdown } from '../types';
import { stripCwd } from '../shared';
import type { NormalizedTask } from '@shared/types';

const COPILOT_QUOTA_LABELS: Record<string, string> = {
  premium_interactions: 'premium',
  chat_interactions: 'chat',
};

/**
 * Convert a Copilot `AssistantUsageQuotaSnapshot` to a `StatusSegment`.
 *
 * Field semantics (verified against `node_modules/@github/copilot/app.js`):
 * - `usedRequests` is *derived* from `entitlement * (1 - percent_remaining)`
 *   so it saturates at `entitlementRequests` and CANNOT itself surface
 *   overage. Using only this field gives a hard 100% ceiling.
 * - `overage` is a separate counter for requests beyond the entitlement
 *   (the upstream API returns it as `overage_count` on `chat`/`premium_interactions`/etc.).
 *
 * → utilization = (usedRequests + overage) / entitlementRequests, so 25
 * overage on a 10-request quota correctly renders 350%.
 *
 * Returns `null` for unlimited entitlements (no meaningful quota %) or when
 * we can't form a denominator.
 */
export function quotaSnapshotToSegment(
  key: string,
  snap: any,
): StatusSegment | null {
  if (!snap || snap.isUnlimitedEntitlement) return null;

  let u: number;
  if (typeof snap.entitlementRequests === 'number'
    && snap.entitlementRequests > 0
    && typeof snap.usedRequests === 'number') {
    const overage = typeof snap.overage === 'number' ? Math.max(0, snap.overage) : 0;
    u = Math.max(0, (snap.usedRequests + overage) / snap.entitlementRequests);
  } else if (typeof snap.remainingPercentage === 'number') {
    // Fallback when request counts are missing — caps at 100% (SDK quirk).
    u = Math.max(0, 1 - snap.remainingPercentage);
  } else {
    return null;
  }

  const label = COPILOT_QUOTA_LABELS[key] ?? key;
  const pct = Math.round(u * 100);
  const reset = snap.resetDate ? formatResetCountdown(Date.parse(snap.resetDate)) : null;
  const severity = snap.usageAllowedWithExhaustedQuota === false && u >= 1
    ? 'critical'
    : severityFromUtilization(u);
  return {
    text: `${label}: ${pct}%${reset ? ` ↻${reset}` : ''}`,
    severity,
  };
}

/**
 * Format a Copilot CLI tool's `arguments` object into a single human-readable
 * string for the renderer. Mirrors `formatClaudeToolInput` but for Copilot's
 * lowercase / snake_case tool names (bash, view, grep, glob, list_directory…).
 *
 * `apply_patch` is parsed separately via `parseApplyPatch`, so we never reach
 * this formatter for it. `task_complete` / `report_intent` are intercepted
 * earlier (rendered as text/intent), also never here.
 *
 * Falls back to first string value / JSON for unknown tools so MCP custom
 * tools still surface something useful.
 */
export function formatCopilotToolInput(toolName: string, args: Record<string, unknown>, cwd: string): string {
  switch (toolName) {
    case 'bash':
    case 'shell':
      return String(args.command ?? '');
    case 'view':
    case 'read_file':
    case 'read': {
      const p = String(args.path ?? args.file_path ?? '');
      return stripCwd(p, cwd);
    }
    case 'list_directory': {
      const p = String(args.path ?? '');
      return stripCwd(p, cwd) || '.';
    }
    case 'grep': {
      const pattern = String(args.pattern ?? args.query ?? '');
      const p = args.path ? ` in ${stripCwd(String(args.path), cwd)}` : '';
      return pattern + p;
    }
    case 'glob': {
      const pattern = String(args.pattern ?? '');
      const p = args.path ? ` in ${stripCwd(String(args.path), cwd)}` : '';
      return pattern + p;
    }
    case 'task': {
      const at = args.agent_type ? `${args.agent_type}: ` : '';
      const name = args.name ? `${args.name} — ` : '';
      const prompt = String(args.prompt ?? args.description ?? '');
      return `${at}${name}${prompt.slice(0, 100)}`;
    }
    default: {
      const firstStr = Object.values(args).find((v) => typeof v === 'string') as string | undefined;
      if (firstStr) return firstStr;
      return JSON.stringify(args);
    }
  }
}

export type ApplyPatchFileSpec =
  | { kind: 'update'; filePath: string; diff: { oldString: string; newString: string } }
  | { kind: 'add'; filePath: string; content: string };

/**
 * In-flight tool calls awaiting their `tool.execution_complete` event, keyed by
 * toolCallId. Stores enough to re-emit the same canonical card with `result`
 * populated when the tool completes — or, if completion never arrives (turn
 * ends while the tool is still running), to finalize it as an orphan.
 */
export type InflightToolUseEntry =
  | { kind: 'tool_use'; toolName: string; input: string }
  | { kind: 'file_edit'; filePath: string; diff?: { oldString: string; newString: string }; content?: string }
  /**
   * `apply_patch` parsed into N file_edit sub-cards. SDK gives a single
   * patch-level success/failure on tool.execution_complete; we re-emit each
   * sub-card with that same result, and additionally emit a top-level error
   * message on failure so the timeline shows the patch-level reason loudly.
   */
  | { kind: 'apply_patch'; subs: Array<{ msgId: string; spec: ApplyPatchFileSpec }> };

/** A terminal "did not complete" card emitted for an orphaned tool call. */
export interface OrphanFinalizeMessage {
  msgId: string;
  msgType: 'fold_code' | 'fold_diff';
  label: string;
  subtitle: string;
  errorMessage: string;
}

/**
 * Build the terminal cards for tool calls still in-flight when a turn ends.
 *
 * When a turn settles (idle / error / abort) some tool cards may still be
 * "running" because their `tool.execution_complete` never arrived — e.g. the
 * Copilot CLI's rg/grep tool hangs internally and never returns (observed:
 * large-scope grep spins forever, no completion, no error). Leaving the
 * fold_code card in a permanent pending state is a silent failure; we finalize
 * each orphan with a loud `errorMessage` so the spinner resolves and the user
 * sees it didn't finish. Shape mirrors the `tool.execution_complete` error
 * branch (same msgId → renderer upserts the running card into a terminal one).
 *
 * Pure: the caller (createCopilotBackend) does the actual `send()`.
 */
export function buildOrphanFinalizeMessages(
  entries: Array<[string, InflightToolUseEntry]>,
  cwd: string,
  errorMessage: string,
): OrphanFinalizeMessage[] {
  const out: OrphanFinalizeMessage[] = [];
  for (const [toolUseId, entry] of entries) {
    if (entry.kind === 'apply_patch') {
      for (const { msgId, spec } of entry.subs) {
        out.push({
          msgId,
          msgType: spec.kind === 'update' ? 'fold_diff' : 'fold_code',
          label: spec.kind === 'update' ? 'Edit' : 'Add',
          subtitle: stripCwd(spec.filePath, cwd),
          errorMessage,
        });
      }
    } else if (entry.kind === 'file_edit') {
      out.push({
        msgId: toolUseId,
        msgType: entry.diff ? 'fold_diff' : 'fold_code',
        label: entry.diff ? 'Edit' : 'Write',
        subtitle: stripCwd(entry.filePath, cwd),
        errorMessage,
      });
    } else {
      out.push({
        msgId: toolUseId,
        msgType: 'fold_code',
        label: entry.toolName,
        subtitle: entry.input,
        errorMessage,
      });
    }
  }
  return out;
}

/**
 * Parse Copilot's `apply_patch` raw-string args into one or more normalized
 * file_edit payloads. Each `*** Update File:` / `*** Add File:` section
 * becomes its own entry; multi-hunk in the same Update file produces multiple
 * entries with the same filePath (one per `@@` hunk — Claude's typical "edit
 * different regions of the same file" pattern maps cleanly).
 *
 * Returns null when the patch contains a `*** Delete File:` (no canonical
 * representation yet) or when the structure is malformed. Caller should fall
 * back to a generic `tool_use` card in that case so nothing is silently lost.
 */
export function parseApplyPatch(patch: string): ApplyPatchFileSpec[] | null {
  if (typeof patch !== 'string') return null;
  // Strip outer Begin/End Patch markers.
  const begin = patch.indexOf('*** Begin Patch');
  const end = patch.indexOf('*** End Patch');
  if (begin < 0 || end < 0 || end < begin) return null;
  const inner = patch.slice(begin + '*** Begin Patch'.length, end).replace(/^\s*\n/, '').replace(/\n\s*$/, '');

  // Delete is the only operation we explicitly don't support yet.
  if (/\*\*\*\s+Delete\s+File:/.test(inner)) return null;

  // Split into file sections. Each section starts with `*** Update|Add File: ...`
  // and continues until the next `*** ` marker or end-of-inner. We use a
  // capture-everything regex with non-greedy lookahead.
  const sectionRe = /\*\*\*\s+(Update|Add)\s+File:\s*([^\n]+)\n([\s\S]*?)(?=\n\*\*\*\s+(?:Update|Add|Delete)\s+File:|$)/g;
  const specs: ApplyPatchFileSpec[] = [];
  let match: RegExpExecArray | null;
  while ((match = sectionRe.exec(inner)) !== null) {
    const op = match[1];
    const filePath = match[2].trim();
    const body = match[3].replace(/\n\s*$/, '');
    if (op === 'Add') {
      const lines: string[] = [];
      for (const line of body.split('\n')) {
        if (line.startsWith('+')) lines.push(line.slice(1));
      }
      specs.push({ kind: 'add', filePath, content: lines.join('\n') });
      continue;
    }
    // op === 'Update' — body starts with `@@` (possibly with optional context),
    // and may contain multiple `@@` hunks. Split on `@@` boundaries.
    const hunks = body.split(/^@@.*$/m).map((h) => h.replace(/^\n+/, '').replace(/\n+$/, '')).filter((h) => h.length > 0);
    if (hunks.length === 0) return null;
    for (const hunk of hunks) {
      const oldLines: string[] = [];
      const newLines: string[] = [];
      for (const line of hunk.split('\n')) {
        if (line.startsWith('+')) newLines.push(line.slice(1));
        else if (line.startsWith('-')) oldLines.push(line.slice(1));
        else if (line.startsWith(' ')) {
          const c = line.slice(1);
          oldLines.push(c);
          newLines.push(c);
        }
        // Empty / non-prefixed lines (e.g. trailing whitespace): ignored.
      }
      specs.push({
        kind: 'update',
        filePath,
        diff: { oldString: oldLines.join('\n'), newString: newLines.join('\n') },
      });
    }
  }

  return specs.length > 0 ? specs : null;
}

// ── Elicitation ↔ picker_request mapping ─────────────────────────────────
// Copilot SDK's elicitation API delivers a JSON-Schema-style form definition
// (ElicitationSchema with N typed properties). We translate that into our
// picker_request shape (multi-question form) and translate the answers back
// into the typed ElicitationResult.content map.
//
// Field-type → prompt mapping table is implemented in
// `elicitationSchemaToPrompts` below — see the function comment + its
// branch structure for the per-type details. Exported for unit testing;
// handler integration lives further down (registerElicitationHandler).

export interface ElicitationFieldEntry {
  /** Property key in the schema (becomes the content map key on resolve). */
  key: string;
  /** Original field definition (used for value coercion on resolve). */
  field: any;
}

export interface ElicitationMapped {
  prompts: Array<{
    question: string;
    header?: string;
    multiSelect: boolean;
    options: Array<{ label: string; description?: string }>;
    inputType?: 'text' | 'number' | 'integer';
    currentValue?: string | string[];
  }>;
  /** Schema fields in property order — used by the answer-coercion step
   *  to map index-aligned picker answers back into a typed content map. */
  fields: ElicitationFieldEntry[];
}

/**
 * Pure mapper: ElicitationSchema → picker_request prompts + ordered field
 * list for the reverse mapping. Returns `null` for empty/malformed schemas
 * — caller should decline the elicitation in that case.
 *
 * Field type → prompt configuration:
 *   string + enum/enumNames     → options from enum (no inputType)
 *   string + oneOf              → options from oneOf.title (no inputType)
 *   array + items.enum          → options, multiSelect=true
 *   array + items.anyOf         → options from anyOf.title, multiSelect=true
 *   boolean                     → options=[Yes,No] (no inputType)
 *   string + format/length      → options=[], inputType='text'
 *   number                      → options=[], inputType='number'
 *   integer                     → options=[], inputType='integer'
 */
export function elicitationSchemaToPrompts(schema: any): ElicitationMapped | null {
  if (!schema || schema.type !== 'object' || !schema.properties) return null;
  const keys = Object.keys(schema.properties);
  if (keys.length === 0) return null;

  const fields: ElicitationFieldEntry[] = [];
  const prompts = keys.map((key) => {
    const field = schema.properties[key];
    fields.push({ key, field });

    // Header is the schema's `title` (clipped to 12 chars to match
    // AskUserQuestion's chip-style header convention); question text is
    // `description` if present, otherwise the property key.
    const header = typeof field.title === 'string' ? field.title.slice(0, 12) : undefined;
    const question = typeof field.description === 'string' ? field.description : key;

    // Boolean
    if (field.type === 'boolean') {
      return {
        question,
        header,
        multiSelect: false,
        options: [{ label: 'Yes' }, { label: 'No' }],
        inputType: undefined,
        currentValue: typeof field.default === 'boolean' ? (field.default ? 'Yes' : 'No') : undefined,
      };
    }

    // String with enum / enumNames (single-select)
    if (field.type === 'string' && Array.isArray(field.enum)) {
      const names: string[] | undefined = Array.isArray(field.enumNames) ? field.enumNames : undefined;
      const options = field.enum.map((v: string, i: number) => ({
        label: names?.[i] ?? v,
        description: names?.[i] ? v : undefined,
      }));
      const def = typeof field.default === 'string' ? field.default : undefined;
      // currentValue uses the displayed label when enumNames provided.
      const defLabel = def !== undefined
        ? (names ? names[field.enum.indexOf(def)] ?? def : def)
        : undefined;
      return { question, header, multiSelect: false, options, inputType: undefined, currentValue: defLabel };
    }

    // String with oneOf (single-select, richer title)
    if (field.type === 'string' && Array.isArray(field.oneOf)) {
      const options = field.oneOf.map((o: any) => ({
        label: String(o?.title ?? o?.const ?? ''),
        description: o?.const && o?.title && o.const !== o.title ? String(o.const) : undefined,
      }));
      const def = typeof field.default === 'string' ? field.default : undefined;
      const defLabel = def !== undefined
        ? field.oneOf.find((o: any) => o.const === def)?.title ?? def
        : undefined;
      return { question, header, multiSelect: false, options, inputType: undefined, currentValue: defLabel };
    }

    // Array of enum strings (multi-select)
    if (field.type === 'array' && field.items?.type === 'string' && Array.isArray(field.items.enum)) {
      const options = field.items.enum.map((v: string) => ({ label: v }));
      const def = Array.isArray(field.default) ? field.default : undefined;
      return { question, header, multiSelect: true, options, inputType: undefined, currentValue: def };
    }

    // Array of anyOf (multi-select, richer titles)
    if (field.type === 'array' && Array.isArray(field.items?.anyOf)) {
      const options = field.items.anyOf.map((o: any) => ({
        label: String(o?.title ?? o?.const ?? ''),
        description: o?.const && o?.title && o.const !== o.title ? String(o.const) : undefined,
      }));
      const def = Array.isArray(field.default)
        ? field.default.map((d: string) => field.items.anyOf.find((o: any) => o.const === d)?.title ?? d)
        : undefined;
      return { question, header, multiSelect: true, options, inputType: undefined, currentValue: def };
    }

    // Numeric (free-text with type hint)
    if (field.type === 'integer' || field.type === 'number') {
      return {
        question,
        header,
        multiSelect: false,
        options: [],
        inputType: field.type as 'integer' | 'number',
        currentValue: typeof field.default === 'number' ? String(field.default) : undefined,
      };
    }

    // Fallback: plain string with no enum (format/length/maxLength hints
    // are dropped — v1 doesn't validate, see agent-ui#3 "Out of scope").
    return {
      question,
      header,
      multiSelect: false,
      options: [],
      inputType: 'text' as const,
      currentValue: typeof field.default === 'string' ? field.default : undefined,
    };
  });

  return { prompts, fields };
}

/**
 * Pure coerce: PickerResolvePayload answers → ElicitationResult.content map.
 *
 * Numeric fields try `parseInt` / `parseFloat`; on parse failure the raw
 * string is sent through so the agent can re-prompt with feedback (we don't
 * validate min/max/format — v1 out-of-scope, see agent-ui#3).
 *
 * Boolean fields map 'Yes' → true, anything else → false. Multi-select array
 * fields with enumNames need to reverse the displayed label back to the const
 * value if the original schema provided enumNames distinct from enum.
 */
export function picksToElicitationContent(
  fields: ElicitationFieldEntry[],
  answers: Array<string | string[]>,
): Record<string, any> {
  const content: Record<string, any> = {};
  fields.forEach((entry, i) => {
    const { key, field } = entry;
    const ans = answers[i];

    if (field.type === 'boolean') {
      content[key] = ans === 'Yes';
      return;
    }

    if (field.type === 'integer') {
      const raw = typeof ans === 'string' ? ans : Array.isArray(ans) ? ans[0] : '';
      const n = parseInt(raw, 10);
      content[key] = Number.isFinite(n) ? n : raw;
      return;
    }
    if (field.type === 'number') {
      const raw = typeof ans === 'string' ? ans : Array.isArray(ans) ? ans[0] : '';
      const n = parseFloat(raw);
      content[key] = Number.isFinite(n) ? n : raw;
      return;
    }

    if (field.type === 'array') {
      const arr = Array.isArray(ans) ? ans : [String(ans ?? '')];
      // Reverse-lookup label → const when the schema used enumNames / anyOf.title.
      if (Array.isArray(field.items?.enum) && Array.isArray(field.items?.enumNames)) {
        content[key] = arr.map((label) => {
          const idx = field.items.enumNames.indexOf(label);
          return idx >= 0 ? field.items.enum[idx] : label;
        });
        return;
      }
      if (Array.isArray(field.items?.anyOf)) {
        content[key] = arr.map((label) => {
          const found = field.items.anyOf.find((o: any) => o.title === label || o.const === label);
          return found?.const ?? label;
        });
        return;
      }
      content[key] = arr;
      return;
    }

    // String single-select (enum/oneOf/freeText)
    const raw = typeof ans === 'string' ? ans : Array.isArray(ans) ? ans[0] : '';
    if (Array.isArray(field.enum) && Array.isArray(field.enumNames)) {
      const idx = field.enumNames.indexOf(raw);
      content[key] = idx >= 0 ? field.enum[idx] : raw;
      return;
    }
    if (Array.isArray(field.oneOf)) {
      const found = field.oneOf.find((o: any) => o.title === raw || o.const === raw);
      content[key] = found?.const ?? raw;
      return;
    }
    content[key] = raw;
  });
  return content;
}

// ── Background tasks ────────────────────────────────────────────────────────
// Pure mapper for the Copilot SDK's TaskInfo (TaskAgentInfo | TaskShellInfo,
// from rpc.tasks.list()) → NormalizedTask render primitives — the same shape
// claude maps its task_* system messages into. Side-effect-free for unit tests.
// See background-tasks#2.

/** Copilot TaskInfo.status → NormalizedTask.status. Copilot's 'idle' (agent
 *  waiting) maps to 'running' (still alive); 'cancelled' → 'stopped'. */
const COPILOT_STATUS_MAP: Record<string, NormalizedTask['status']> = {
  pending: 'pending',
  running: 'running',
  idle: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'stopped',
};
const TERMINAL_COPILOT_STATUS = new Set<NormalizedTask['status']>(['completed', 'failed', 'stopped']);

function mapCopilotStatus(s: unknown): NormalizedTask['status'] {
  return (typeof s === 'string' && COPILOT_STATUS_MAP[s]) || 'running';
}

/**
 * Map one Copilot TaskInfo into a NormalizedTask. PURE. `type: 'agent'` →
 * 'agent', `type: 'shell'` → 'shell'. Shell carries `command`; agent's
 * `error` surfaces as the task error. Returns null for malformed input.
 */
export function normalizeCopilotTask(t: any): NormalizedTask | null {
  if (!t || typeof t.id !== 'string' || !t.id) return null;
  const status = mapCopilotStatus(t.status);
  return {
    id: t.id,
    type: t.type === 'shell' ? 'shell' : t.type === 'agent' ? 'agent' : 'unknown',
    label: typeof t.description === 'string' ? t.description : t.id,
    status,
    command: typeof t.command === 'string' ? t.command : undefined,
    error: typeof t.error === 'string' ? t.error : undefined,
    done: TERMINAL_COPILOT_STATUS.has(status),
  };
}

/** Is this a genuinely-backgrounded task (vs a synchronous foreground one)?
 *  Only these become cards. `executionMode === 'background'` is the signal. */
export function isBackgroundedCopilotTask(t: any): boolean {
  return t?.executionMode === 'background';
}

/**
 * Transitional Copilot auth-config selection (pure).
 *
 * If a gh-derived token is available, pass it as `gitHubToken` (which forces
 * `useLoggedInUser: false`): the spawned Copilot CLI then uses that token and
 * NEVER touches its own keychain-stored login → no macOS Keychain prompt (gh
 * keeps its token in a plaintext file, not the keychain). If no gh token, fall
 * back to `useLoggedInUser: true` (Copilot's own login, which on macOS lives in
 * the keychain → may prompt on unsigned builds).
 *
 * gh is OPTIONAL — a convenience to avoid the keychain prompt when it happens to
 * be installed+authed, NOT a hard dependency. See agent-providers#2.
 */
export function buildCopilotAuthConfig(
  ghToken: string | undefined,
): { gitHubToken: string; useLoggedInUser: false } | { useLoggedInUser: true } {
  return ghToken
    ? { gitHubToken: ghToken, useLoggedInUser: false }
    : { useLoggedInUser: true };
}

