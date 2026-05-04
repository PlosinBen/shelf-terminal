export const COMPACTION_BUFFER = 4_000;
export const COMPACTION_MIN_TOKENS = 20_000;
export const TOOL_OUTPUT_MAX_CHARS = 2_000;
export const DEFAULT_TAIL_TURNS = 2;

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: { id: string; toolName: string; input: Record<string, unknown>; result?: string }[];
}

export function needsCompaction(totalTokens: number, contextWindow: number): boolean {
  if (totalTokens < COMPACTION_MIN_TOKENS) return false;
  return totalTokens > contextWindow - COMPACTION_BUFFER;
}

export function splitForCompaction(
  messages: HistoryMessage[],
  tailTurns: number = DEFAULT_TAIL_TURNS,
): { head: HistoryMessage[]; tail: HistoryMessage[] } {
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userCount++;
      if (userCount >= tailTurns) {
        return { head: messages.slice(0, i), tail: messages.slice(i) };
      }
    }
  }
  return { head: [], tail: messages.slice() };
}

export function truncateToolOutputs(items: HistoryMessage[]): HistoryMessage[] {
  return items.map((item) => {
    if (!item.toolCalls) return item;
    return {
      ...item,
      toolCalls: item.toolCalls.map((tc) => {
        if (!tc.result || tc.result.length <= TOOL_OUTPUT_MAX_CHARS) return tc;
        return {
          ...tc,
          result: tc.result.slice(0, TOOL_OUTPUT_MAX_CHARS) +
            `\n… [truncated ${tc.result.length - TOOL_OUTPUT_MAX_CHARS} chars]`,
        };
      }),
    };
  });
}

export function buildCompactionPrompt(head: HistoryMessage[]): string {
  const rendered: string[] = [];
  for (const item of head) {
    if (item.role === 'system') continue;
    rendered.push(`[${item.role}] ${item.content}`);
    if (item.toolCalls) {
      for (const tc of item.toolCalls) {
        const input = JSON.stringify(tc.input).slice(0, 500);
        const result = (tc.result || '').slice(0, 500);
        rendered.push(`[tool:${tc.toolName}] input=${input} result=${result}`);
      }
    }
  }
  return `Summarize the prior conversation for future reference. Produce concise Markdown with these sections:
- Goal
- Constraints
- Progress (completed / partial)
- Decisions
- Next
- Files touched

Conversation so far:

${rendered.join('\n\n')}`;
}
