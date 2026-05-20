import type { AgentMsg } from './components/AgentMessage';

let nextMsgIdCounter = 0;
function freshMsgId(prefix: string): string {
  nextMsgIdCounter += 1;
  return `${prefix}-${Date.now()}-${nextMsgIdCounter}`;
}

/**
 * Translate the canonical AgentMessage payload (wire shape from agent-server)
 * into the renderer-side `AgentMsg` variant. Unknown / malformed payloads
 * return null so the caller can drop them. Provider field is attached for
 * assistant-text labeling.
 *
 * Note: `plan` messages are NOT translated here — they're consumed by the
 * sticky panel before the message stream. The IPC subscription in
 * agentTabSubscriptions intercepts type === 'plan' and calls setPlan
 * instead.
 */
export function buildAgentMsg(msg: any, provider: string): AgentMsg | null {
  // `id` is the universal upsert key — equals `msg.msgId` from the wire
  // (which equals toolUseId for tool messages). Provider-minted; renderer
  // uses it both as React key and as upsert key. Fall back to a synthetic
  // id for messages from older agent-server bundles.
  const id: string = msg.msgId ?? msg.toolUseId ?? freshMsgId('msg');
  const ts = Date.now();
  switch (msg.type) {
    case 'text':
      return { id, type: 'text', content: msg.content ?? '', provider, timestamp: ts };
    case 'thinking':
      return { id, type: 'thinking', content: msg.content ?? '', provider, timestamp: ts };
    case 'intent':
      return { id, type: 'intent', content: msg.content ?? '', provider, timestamp: ts };
    case 'system':
      return { id, type: 'system', content: msg.content ?? '', provider, timestamp: ts };
    case 'error':
      return { id, type: 'error', content: msg.content ?? 'Unknown error', provider, timestamp: ts };
    case 'tool_use':
      if (!msg.toolUseId || !msg.toolName) return null;
      return {
        id,
        type: 'tool_use',
        toolUseId: msg.toolUseId,
        toolName: msg.toolName,
        // Provider sends `input: string`. Defensively coerce in case an
        // older agent-server bundle still emits structured toolInput.
        input: typeof msg.input === 'string'
          ? msg.input
          : msg.toolInput
            ? JSON.stringify(msg.toolInput)
            : '',
        ...(msg.result ? { result: msg.result } : {}),
        provider,
        timestamp: ts,
      };
    case 'slash_response':
      if (typeof msg.slashCmd !== 'string' || typeof msg.content !== 'string') return null;
      if (msg.status !== 'pending' && msg.status !== 'success' && msg.status !== 'error') return null;
      return {
        id,
        type: 'slash_response',
        slashCmd: msg.slashCmd,
        status: msg.status,
        content: msg.content,
        provider,
        timestamp: ts,
      };
    case 'file_edit':
      if (!msg.toolUseId || !msg.filePath) return null;
      return {
        id,
        type: 'file_edit',
        toolUseId: msg.toolUseId,
        filePath: msg.filePath,
        ...(msg.diff ? { diff: msg.diff } : {}),
        ...(typeof msg.content === 'string' ? { content: msg.content } : {}),
        ...(msg.result ? { result: msg.result } : {}),
        provider,
        timestamp: ts,
      };
    default:
      return null;
  }
}
