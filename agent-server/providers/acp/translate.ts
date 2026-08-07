// Pure ACP → Shelf-wire translation.
//
// This is the semantics-FREE core of the shared `acp/` toolkit (agent-providers#6):
// it maps ACP `session/update` variants onto Shelf's render primitives
// (`stream` / `message` fold_* / `plan`) and knows NOTHING about which agent
// (codex / gemini / …) produced them. Per-agent semantics (mode names, model
// format, auth) live in the per-agent backend, never here.
//
// Kept PURE (no I/O, no SDK runtime — TYPE-only import) so it is exhaustively
// unit-testable without a live agent. The stateful lifecycle (accumulating the
// final reply, emitting turn-end status) is the CLIENT's job, not translate's.

import type {
  SessionUpdate,
  ContentBlock,
  PlanEntry,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type { OutgoingMessage } from '../types';
import { severityFromUtilization } from '../types';

/**
 * Fallback msgId for streamed assistant text when the agent omits `messageId`.
 * Agents that DO omit it (e.g. copilot --acp) would otherwise reuse this constant
 * across turns → the renderer upserts every turn's reply onto ONE entry. The
 * session driver detects this sentinel and namespaces it per-turn (see client.ts).
 */
export const DEFAULT_AGENT_MSG_ID = 'agent-message';

/** Flatten a single ACP ContentBlock to display text (non-text blocks degrade). */
export function contentBlockToText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource_link':
      return block.uri ? `[${block.name ?? block.uri}](${block.uri})` : (block.name ?? '');
    case 'resource':
      // EmbeddedResource: prefer inline text if present, else nothing renderable.
      return 'text' in block.resource && typeof (block.resource as { text?: unknown }).text === 'string'
        ? (block.resource as { text: string }).text
        : '';
    case 'image':
    case 'audio':
      return '';
    default:
      return '';
  }
}

/** Parse a `data:<mime>;base64,<data>` URL into its parts (null if not one). */
function parseImageDataUrl(url: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return m ? { mimeType: m[1], data: m[2] } : null;
}

/**
 * Build ACP image ContentBlocks from renderer data-URL images (for a prompt's
 * content array). Non-data-URL / unparseable entries are dropped. Pure — the
 * agent's promptCapabilities.image gates actual support; we forward regardless
 * (matches native copilot) and let the agent error if it can't.
 */
export function imageContentBlocks(images: string[] | undefined): ContentBlock[] {
  return (images ?? [])
    .map(parseImageDataUrl)
    .filter((x): x is { mimeType: string; data: string } => x !== null)
    .map(({ mimeType, data }) => ({ type: 'image', data, mimeType }));
}

/** Render an ACP plan (`entries`) as a markdown checklist for the `plan` side-channel. */
export function renderPlan(entries: PlanEntry[]): string {
  return entries
    .map((e) => {
      const box = e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]';
      return `- ${box} ${e.content}`;
    })
    .join('\n');
}

/** Concatenate a tool call's textual content blocks (used for fold_code body). */
function toolContentToText(content: ToolCallContent[] | null | undefined): string {
  if (!content) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === 'content') parts.push(contentBlockToText(c.content));
    // 'diff' handled separately (fold_diff); 'terminal' has no inline text here.
  }
  return parts.join('\n');
}

/**
 * Displayable text from a tool's `rawOutput` — a FALLBACK when the ACP `content`
 * array is empty. copilot puts read/view file text ONLY in `rawOutput.content`
 * (never the standard `content` array), so without this the read card is blank.
 * `rawOutput` is agent-defined (`unknown`); handle the common shapes: a bare
 * string, `{content}` (copilot), or `{formatted_output}` (codex shell).
 */
function rawOutputToText(rawOutput: unknown): string {
  if (typeof rawOutput === 'string') return rawOutput;
  if (rawOutput && typeof rawOutput === 'object') {
    const o = rawOutput as Record<string, unknown>;
    if (typeof o.content === 'string') return o.content;
    if (typeof o.formatted_output === 'string') return o.formatted_output;
  }
  return '';
}

/** First diff block in a tool call's content, if any (drives fold_diff vs fold_code). */
function firstDiff(content: ToolCallContent[] | null | undefined): { oldText?: string | null; newText: string; path?: string } | undefined {
  if (!content) return undefined;
  for (const c of content) {
    if (c.type === 'diff') return { oldText: c.oldText, newText: c.newText, path: c.path };
  }
  return undefined;
}

/** `failed` → surface as an error card; other statuses render normally. */
function errorFor(status: ToolCallStatus | null | undefined): string | undefined {
  return status === 'failed' ? 'Tool call failed' : undefined;
}

/**
 * Carry a tool call's title + kind forward across its updates, for ONE turn.
 *
 * ACP tool-call updates are PARTIAL: only the initial `tool_call` carries a
 * REQUIRED `title`; a `tool_call_update` (status/content change) usually omits
 * title AND kind ("unchanged"). Shelf's wire `message` is a full upsert-by-msgId —
 * the renderer REPLACES the card by msgId — so a title/kind-less update would
 * clobber the card back to defaults. Resolve ACP's partial semantics HERE (the
 * provider owns provider semantics; the renderer stays a dumb full-replace):
 * remember the last-seen title + kind per `toolCallId` and re-inject them into
 * later updates. A session router owns one carry: terminal updates are enriched
 * before their entry is evicted, and dropping the router clears all remaining
 * entries on session reset/forget.
 */
export function createToolMetaCarry(): (update: SessionUpdate) => SessionUpdate {
  const metaByToolCall = new Map<string, { title?: string; kind?: ToolKind }>();
  return (update) => {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
      return update;
    }
    const prev = metaByToolCall.get(update.toolCallId) ?? {};
    const title = (update.title || prev.title) ?? undefined;
    const kind = (update.kind || prev.kind) ?? undefined;
    const carried = { ...update, ...(title ? { title } : {}), ...(kind ? { kind } : {}) } as SessionUpdate;
    const status = 'status' in update ? update.status : undefined;
    if (status === 'completed' || status === 'failed') metaByToolCall.delete(update.toolCallId);
    else metaByToolCall.set(update.toolCallId, { title, kind });
    return carried;
  };
}

/**
 * ACP `ToolKind` → a short, scannable tool-name for the card LABEL (pink), matching
 * the claude provider's "label = tool name, subtitle = target" convention. Keeping
 * the label short + repetitive (vs copilot's long descriptive `title`) is what makes
 * a column of tool cards readable — the descriptive `title` goes to the subtitle.
 * `other` (copilot's catch-all — it tags search as `other`) and missing kind fall to
 * a generic 'Tool'.
 */
const TOOL_KIND_LABELS: Record<ToolKind, string> = {
  read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search',
  execute: 'Execute', think: 'Think', fetch: 'Fetch', switch_mode: 'Switch', other: 'Tool',
};
function toolKindLabel(kind: ToolKind | null | undefined): string {
  return (kind && TOOL_KIND_LABELS[kind]) || 'Tool';
}

function toolCallLabel(kind: ToolKind | null | undefined, title: string | undefined): string {
  // Copilot ACP collapses some tool names into broad kinds; its generated title
  // preserves the more precise find/search intent. Keep the kind map as fallback.
  // See agent-providers#41.
  if (kind === 'read' && title?.startsWith('Finding')) return 'Find';
  if (kind === 'other' && title?.startsWith('Searching')) return 'Search';
  return toolKindLabel(kind);
}

/**
 * Map ONE ACP `SessionUpdate` to zero or more Shelf wire messages (WITHOUT a
 * executionId — the send wrapper stamps that). Returns `[]` for updates that are not
 * timeline render primitives (capabilities/mode/config/usage are consumed by the
 * stateful client, not rendered here). Tool-call updates should be run through a
 * session-scoped {@link createToolMetaCarry} first so title/kind survive partial updates.
 */
export function translateSessionUpdate(update: SessionUpdate): OutgoingMessage[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const content = contentBlockToText(update.content);
      if (!content) return [];
      return [{ type: 'stream', msgId: update.messageId ?? DEFAULT_AGENT_MSG_ID, streamType: 'text', content }];
    }
    case 'agent_thought_chunk': {
      const content = contentBlockToText(update.content);
      if (!content) return [];
      return [{ type: 'stream', msgId: update.messageId ?? DEFAULT_AGENT_MSG_ID, streamType: 'thinking', content }];
    }
    case 'plan':
      return [{ type: 'plan', content: renderPlan(update.entries) }];
    case 'plan_update':
      // PlanUpdate carries a full replacement list of entries too.
      return [{ type: 'plan', content: renderPlan((update as { entries?: PlanEntry[] }).entries ?? []) }];
    case 'tool_call':
    case 'tool_call_update': {
      // label = short `kind` name (pink, scannable); subtitle = the descriptive
      // `title` (gray detail). Mirrors the claude provider (label='Read',
      // subtitle=<target>) — a column of short labels reads far better than a wall
      // of copilot's long titles. Both survive partial updates via createToolMetaCarry.
      const msgId = update.toolCallId;
      const title = ('title' in update && update.title) ? update.title : undefined;
      // copilot delivers its FINAL SUMMARY via a `task_complete` signal tool (not
      // plain assistant text; ACP's turn-completion signal is the turn-level
      // stopReason, so agents lean on a tool for the closing message). Surface that
      // summary as the turn's closing `reply` (it's markdown) instead of a buried
      // "Tool" card. A bare signal (initial pending call, no content) emits nothing.
      // Copilot-specific title match — no ACP standard marker exists; revisit if it
      // is renamed. `title` is carried across partial updates (createToolMetaCarry).
      if (title === 'task_complete') {
        const summary = toolContentToText('content' in update ? update.content : undefined)
          || rawOutputToText('rawOutput' in update ? update.rawOutput : undefined);
        return summary ? [{ type: 'message', msgId, msgType: 'reply', content: summary }] : [];
      }
      const label = toolCallLabel('kind' in update ? update.kind : undefined, title);
      const status = 'status' in update ? update.status : undefined;
      const errorMessage = errorFor(status);
      const diff = firstDiff('content' in update ? update.content : undefined);
      // subtitle = the affected file PATH (ACP `locations`, else the diff block's
      // path), matching claude (`Edit` → subtitle=<path>). copilot's edit/apply_patch
      // `title` is a generic "apply_patch" — the path is what's useful. Falls back to
      // the title for tools with no file (execute/search) or no locations.
      const filePath = ('locations' in update ? update.locations?.[0]?.path : undefined) || diff?.path;
      const subtitle = filePath || title;
      if (diff) {
        return [{
          type: 'message', msgId, msgType: 'fold_diff', label,
          ...(subtitle ? { subtitle } : {}),
          ...(errorMessage ? { errorMessage } : {}),
          body: { diff: { oldString: diff.oldText ?? '', newString: diff.newText } },
        }];
      }
      // `content` is the ACP-standard display array; fall back to `rawOutput` when
      // it's empty — copilot ships read/view file text ONLY in rawOutput.
      const bodyText = toolContentToText('content' in update ? update.content : undefined)
        || rawOutputToText('rawOutput' in update ? update.rawOutput : undefined);
      // Emit a body for a COMPLETED tool even when it produced no text at all.
      // Otherwise the card is body-less AND error-less, which the renderer's reload
      // path (reviveOrphanPending in agent-history) misreads as a crashed in-flight
      // tool and stamps "Session ended before completion". A settled empty body
      // marks it as done-with-no-output; an in-flight card stays body-less so a
      // genuine mid-call crash is still surfaced on reload.
      const settled = status === 'completed';
      return [{
        type: 'message', msgId, msgType: 'fold_code', label,
        ...(subtitle ? { subtitle } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...((bodyText || settled) ? { body: { content: bodyText } } : {}),
      }];
    }
    case 'usage_update': {
      // Context-window usage → a live status segment. The renderer retains the
      // last contextUsage across the turn-end idle, so emitting it mid-turn on the
      // streaming status is enough (matches native copilot's `ctx: NN%`).
      const size = (update as { size?: number }).size ?? 0;
      const used = (update as { used?: number }).used ?? 0;
      const ratio = size > 0 ? used / size : 0;
      return [{
        type: 'status', state: 'streaming',
        contextUsage: { text: `ctx: ${Math.round(ratio * 100)}%`, severity: severityFromUtilization(ratio) },
      }];
    }
    // Not timeline render primitives — handled by the stateful client (caps /
    // mode) or intentionally ignored here.
    case 'user_message_chunk':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'plan_removed':
    default:
      return [];
  }
}
