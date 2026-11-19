import type { SessionUpdate } from '@agentclientprotocol/sdk';

/** Remove only the success trailer corroborated by a structured shell ID. */
export function normalizeCopilotCommandOutput(update: SessionUpdate): SessionUpdate {
  if ((update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
    || update.status !== 'completed') return update;
  const output = update.rawOutput;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return update;
  const raw = output as Record<string, unknown>;
  const structured = raw.structuredContent;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return update;
  const shellId = (structured as Record<string, unknown>).shellId;
  if (typeof shellId !== 'string' || !/^\d{1,20}$/.test(shellId) || typeof raw.content !== 'string') return update;
  const trailer = `<shellId: ${shellId} completed with exit code 0>`;
  const original = raw.content;
  if (original !== trailer && !original.endsWith(`\n${trailer}`)) return update;
  const prefix = original.slice(0, -trailer.length);
  const content = prefix === '\n' || prefix === '\r\n' ? '' : prefix;
  return {
    ...update,
    rawOutput: { ...raw, content },
    ...(update.content ? { content: update.content.map(block =>
      block.type === 'content' && block.content.type === 'text' && block.content.text === original
        ? { ...block, content: { ...block.content, text: content } } : block) } : {}),
  };
}
