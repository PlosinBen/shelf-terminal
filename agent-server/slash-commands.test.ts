import { describe, it, expect } from 'vitest';
import { createCopilotBackend } from './providers/copilot';
import type { OutgoingMessage, SendFn, QueryInput } from './providers/types';

/**
 * Test helper — captures all messages emitted by the provider via the wire
 * send fn. Slash commands flow through `query()`: provider parses the prefix
 * internally and dispatches via dispatchSlash. Output is emitted as
 * fold_markdown wire messages (pending → success/error upsert by msgId).
 */
function makeSendCapture(): { send: SendFn; emitted: OutgoingMessage[] } {
  const emitted: OutgoingMessage[] = [];
  const send: SendFn = (msg) => { emitted.push(msg); };
  return { send, emitted };
}

type FoldMarkdownMsg = Extract<OutgoingMessage, { type: 'message'; msgType: 'fold_markdown' }>;

function pickFoldMarkdown(emitted: OutgoingMessage[]): FoldMarkdownMsg[] {
  return emitted.filter(
    (m): m is FoldMarkdownMsg =>
      m.type === 'message' && (m as any).msgType === 'fold_markdown',
  );
}

function makeQueryInput(prompt: string): QueryInput {
  return { prompt, cwd: '/tmp' };
}

describe('Copilot slash dispatch via query()', () => {
  it('/clear without prior session emits pending → success fold_markdown', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/clear'), send);
    const responses = pickFoldMarkdown(emitted);
    expect(responses.length).toBe(2);
    // Pending: no body, no errorMessage.
    expect(responses[0].label).toBe('/clear');
    expect(responses[0].body).toBeUndefined();
    expect(responses[0].errorMessage).toBeUndefined();
    // Success: body present, no errorMessage.
    expect(responses[1].body?.content).toMatch(/cleared/i);
    expect(responses[1].errorMessage).toBeUndefined();
    expect(responses[0].msgId).toBe(responses[1].msgId);
    backend.dispose();
  });

  it('/help emits one success fold_markdown listing commands', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/help'), send);
    const responses = pickFoldMarkdown(emitted);
    expect(responses.length).toBe(1);
    expect(responses[0].label).toBe('/help');
    expect(responses[0].errorMessage).toBeUndefined();
    expect(responses[0].body?.content).toContain('/clear');
    expect(responses[0].body?.content).toContain('/compact');
    expect(responses[0].body?.content).toContain('/context');
    expect(responses[0].body?.content).toContain('/help');
    backend.dispose();
  });

  it('/context emits error fold_markdown when no usage tracked yet', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/context'), send);
    const responses = pickFoldMarkdown(emitted);
    expect(responses.length).toBe(2);
    expect(responses[0].body).toBeUndefined();
    expect(responses[1].errorMessage).toMatch(/no context info/i);
    backend.dispose();
  });

  it('/compact before any session emits error fold_markdown', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/compact'), send);
    const responses = pickFoldMarkdown(emitted);
    expect(responses.length).toBe(2);
    expect(responses[0].body).toBeUndefined();
    expect(responses[1].errorMessage).toMatch(/no active session/i);
    backend.dispose();
  });

  it('unknown command emits error fold_markdown', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/foobar'), send);
    const responses = pickFoldMarkdown(emitted);
    expect(responses.length).toBe(1);
    expect(responses[0].errorMessage).toContain('foobar');
    backend.dispose();
  });

  it('emits streaming → idle status pair around slash dispatch (no cost/tokens on slash idle)', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/help'), send);
    const statusEvents = emitted.filter((m) => m.type === 'status') as Extract<OutgoingMessage, { type: 'status' }>[];
    expect(statusEvents.length).toBe(2);
    expect(statusEvents[0].state).toBe('streaming');
    expect(statusEvents[1].state).toBe('idle');
    expect(statusEvents[1].costUsd).toBeUndefined();
    expect(statusEvents[1].inputTokens).toBeUndefined();
    expect(statusEvents[1].numTurns).toBeUndefined();
    expect(statusEvents[1].contextUsage).toBeUndefined();
    backend.dispose();
  });
});
