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

/** First diff block in a tool call's content, if any (drives fold_diff vs fold_code). */
function firstDiff(content: ToolCallContent[] | null | undefined): { oldText?: string | null; newText: string } | undefined {
  if (!content) return undefined;
  for (const c of content) {
    if (c.type === 'diff') return { oldText: c.oldText, newText: c.newText };
  }
  return undefined;
}

/** `failed` → surface as an error card; other statuses render normally. */
function errorFor(status: ToolCallStatus | null | undefined): string | undefined {
  return status === 'failed' ? 'Tool call failed' : undefined;
}

/**
 * Map ONE ACP `SessionUpdate` to zero or more Shelf wire messages (WITHOUT a
 * turnId — the send wrapper stamps that). Returns `[]` for updates that are not
 * timeline render primitives (capabilities/mode/config/usage are consumed by the
 * stateful client, not rendered here).
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
      const msgId = update.toolCallId;
      const label = ('title' in update && update.title) ? update.title : 'Tool';
      const kind = 'kind' in update ? update.kind : undefined;
      const status = 'status' in update ? update.status : undefined;
      const errorMessage = errorFor(status);
      const diff = firstDiff('content' in update ? update.content : undefined);
      if (diff) {
        return [{
          type: 'message', msgId, msgType: 'fold_diff', label,
          ...(kind ? { subtitle: kind } : {}),
          ...(errorMessage ? { errorMessage } : {}),
          body: { diff: { oldString: diff.oldText ?? '', newString: diff.newText } },
        }];
      }
      const bodyText = toolContentToText('content' in update ? update.content : undefined);
      return [{
        type: 'message', msgId, msgType: 'fold_code', label,
        ...(kind ? { subtitle: kind } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(bodyText ? { body: { content: bodyText } } : {}),
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
