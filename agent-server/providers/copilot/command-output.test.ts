import { describe, it, expect } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { normalizeCopilotCommandOutput } from './command-output';

const event = (content: string, shellId: unknown = '14', status = 'completed'): SessionUpdate => ({
  sessionUpdate: 'tool_call_update', toolCallId: 'shell', status,
  rawOutput: { content, structuredContent: { shellId } },
  content: [{ type: 'content', content: { type: 'text', text: content } }],
} as SessionUpdate);

describe('Copilot command output', () => {
  it.each([['\n<shellId: 14 completed with exit code 0>', ''],
    ['hello\n<shellId: 14 completed with exit code 0>', 'hello\n']])('removes the corroborated trailer from %s', (text, expected) => {
    const original = event(text);
    expect(normalizeCopilotCommandOutput(original)).toMatchObject({ rawOutput: { content: expected },
      content: [{ content: { text: expected } }] });
    expect(original).toMatchObject({ rawOutput: { content: text } });
  });
  it.each([
    event('<shellId: 14 completed with exit code 1>'),
    event('<shellId: 14 completed with exit code 0>', '15'),
    event('<shellId: 14 completed with exit code 0>', '14', 'failed'),
    event('<shellId: 14 completed with exit code 0>', null),
    event('user text <shellId: 14 completed with exit code 0>'),
    event('<shellId: 14 completed with exit code 0>\nmore output'),
  ])('preserves unconfirmed or failed output', update => {
    expect(normalizeCopilotCommandOutput(update)).toBe(update);
  });
});
