import type { ChatMessage } from './llm-client';

/**
 * Trim chat history to roughly `maxTurns` recent messages, while keeping the
 * sliced head on a `user` boundary so we never start with a bare function_call
 * (assistant with tool_calls) or an orphan function_response (tool without its
 * preceding call). Gemini rejects such sequences with HTTP 400
 * "function call turn must come immediately after a user turn or after a
 * function response turn"; OpenAI tolerates them but the structure is still
 * malformed.
 *
 * If walking back to a user turn pulls in extra messages, that's intentional —
 * we'd rather send slightly more history than break the call.
 */
export function trimHistoryForLLM(history: ChatMessage[], maxTurns: number): ChatMessage[] {
  if (history.length <= maxTurns) return history;
  let start = history.length - maxTurns;
  while (start > 0 && history[start].role !== 'user') {
    start--;
  }
  return history.slice(start);
}
