import { AGENT_DIFF_ERROR, readAgentDiff } from '@shared/agent-diff';
import { readAgentExecution } from '@shared/agent-execution';
import type { AgentMsg } from './components/AgentMessage';
import { validateAgentInputMessage } from '@shared/agent-input';

let nextMsgIdCounter = 0;
function freshMsgId(prefix: string): string {
  nextMsgIdCounter += 1;
  return `${prefix}-${Date.now()}-${nextMsgIdCounter}`;
}

/**
 * Translate the canonical wire AgentMessage payload (from agent-server via main)
 * into the renderer-side `AgentMsg` variant. Unknown / malformed payloads
 * return null so the caller can drop them. Provider field is attached for
 * the assistant reply label.
 *
 * Plan messages do NOT pass through here — they travel on their own
 * AGENT_PLAN IPC channel and land in `agentTabStore.currentPlan` via the
 * dedicated subscription in `agentTabSubscriptions.ts`.
 */
export function buildAgentMsg(msg: any, provider: string): AgentMsg | null {
  const built = buildAgentMsgInner(msg, provider);
  // Transport turn markers are intentionally not copied: renderer history is
  // one linear timeline and cannot gate presentation on execution lifecycle.
  // Subagent nesting link — carry through so the timeline nests it under the
  // outer Agent card instead of the main list. See subagent-display.
  if (built && typeof msg.parentToolUseId === 'string') built.parentToolUseId = msg.parentToolUseId;
  return built;
}

function buildAgentMsgInner(msg: any, provider: string): AgentMsg | null {
  const id: string = msg.msgId ?? freshMsgId('msg');
  const ts = Date.now();

  const foldBase = (m: any) => ({
    label: typeof m.label === 'string' ? m.label : '',
    ...(typeof m.subtitle === 'string' ? { subtitle: m.subtitle } : {}),
    ...(typeof m.errorMessage === 'string' ? { errorMessage: m.errorMessage } : {}),
  });

  switch (msg.type) {
    case 'reply':
      return { id, type: 'reply', content: msg.content ?? '', provider, timestamp: ts };
    case 'note':
      return { id, type: 'note', content: msg.content ?? '', provider, timestamp: ts };
    case 'system':
      return { id, type: 'system', content: msg.content ?? '', provider, timestamp: ts };
    case 'error':
      return { id, type: 'error', content: msg.content ?? 'Unknown error', provider, timestamp: ts };
    case 'user':
      // Wire-emitted user bubble. Providers never emit this — but main can
      // (e.g. the Telegram bridge mirrors forwarded prompts so the agent view
      // history shows the message that was sent on the user's behalf).
      const checked = msg.inputMessage === undefined ? undefined : validateAgentInputMessage(msg.inputMessage);
      if (checked && (!checked.ok || checked.message.msgId !== id || checked.message.content !== msg.content)) {
        console.error('Invalid mirrored Agent input metadata', { msgId: id, error: checked.ok ? 'Message identity/content mismatch' : checked.error });
        return null;
      }
      return {
        id, type: 'user', content: msg.content ?? '', timestamp: ts,
        ...(checked?.ok ? { inputMessage: checked.message } : {}),
        ...(Array.isArray(msg.images) && msg.images.length > 0 ? { images: msg.images } : {}),
        ...(Array.isArray(msg.files) && msg.files.length > 0 ? { files: msg.files } : {}),
      };
    case 'fold_text':
      return {
        id, type: 'fold_text', ...foldBase(msg),
        ...(msg.body && typeof msg.body.content === 'string'
          ? { body: { content: msg.body.content, ...(msg.body.tone === 'muted' ? { tone: 'muted' as const } : {}) } }
          : {}),
        provider, timestamp: ts,
      };
    case 'fold_code': {
      const checked = readAgentExecution(msg.execution);
      if (checked.anomaly) console.warn(checked.anomaly, { msgId: id });
      return {
        id, type: 'fold_code', ...foldBase(msg),
        ...(checked.execution ? { execution: checked.execution } : {}),
        ...(msg.body && typeof msg.body.content === 'string'
          ? { body: { content: msg.body.content } }
          : {}),
        provider, timestamp: ts,
      };
    }
    case 'fold_markdown':
      return {
        id, type: 'fold_markdown', ...foldBase(msg),
        ...(msg.body && typeof msg.body.content === 'string'
          ? { body: { content: msg.body.content } }
          : {}),
        provider, timestamp: ts,
      };
    case 'fold_diff': {
      const checked = msg.body === undefined ? undefined : readAgentDiff(msg.body?.diff);
      if (checked && !checked.ok) console.warn('Invalid diff body', { msgId: id, reason: checked.reason });
      return {
        id, type: 'fold_diff', ...foldBase(msg),
        ...(checked?.ok ? { body: { diff: checked.diff } } : {}),
        ...(checked && !checked.ok ? { errorMessage: [msg.errorMessage, AGENT_DIFF_ERROR].filter(Boolean).join('; ') } : {}),
        provider, timestamp: ts,
      };
    }
    default:
      return null;
  }
}
