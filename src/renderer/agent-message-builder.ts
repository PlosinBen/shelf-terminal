import type { AgentMsg } from './components/AgentMessage';

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
  // Server-initiated turn marker (auto-resume prose) — carry through so
  // buildTurns opens a fresh turn block for it. See DECISIONS #69.
  if (built && msg.startsTurn) built.startsTurn = true;
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
      return {
        id, type: 'user', content: msg.content ?? '', timestamp: ts,
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
    case 'fold_code':
      return {
        id, type: 'fold_code', ...foldBase(msg),
        ...(msg.body && typeof msg.body.content === 'string'
          ? { body: { content: msg.body.content } }
          : {}),
        provider, timestamp: ts,
      };
    case 'fold_markdown':
      return {
        id, type: 'fold_markdown', ...foldBase(msg),
        ...(msg.body && typeof msg.body.content === 'string'
          ? { body: { content: msg.body.content } }
          : {}),
        provider, timestamp: ts,
      };
    case 'fold_diff':
      return {
        id, type: 'fold_diff', ...foldBase(msg),
        ...(msg.body && msg.body.diff
          && typeof msg.body.diff.oldString === 'string'
          && typeof msg.body.diff.newString === 'string'
          ? { body: { diff: { oldString: msg.body.diff.oldString, newString: msg.body.diff.newString } } }
          : {}),
        provider, timestamp: ts,
      };
    default:
      return null;
  }
}
