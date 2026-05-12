import { describe, it, expect } from 'vitest';
import { createClaudeBackend } from './providers/claude';
import { createCopilotBackend } from './providers/copilot';
import type { OutgoingMessage, SendFn } from './providers/types';

/**
 * Test helper — captures all messages emitted by the provider via the wire
 * send fn so assertions can inspect what slash_response (or other) payloads
 * were produced. Replaces the prior pattern of asserting on SlashResult
 * shape, which no longer carries the actual UI content for migrated commands.
 */
function makeSendCapture(): { send: SendFn; emitted: OutgoingMessage[] } {
  const emitted: OutgoingMessage[] = [];
  const send: SendFn = (msg) => { emitted.push(msg); };
  return { send, emitted };
}

function pickSlashResponses(emitted: OutgoingMessage[]) {
  return emitted.filter(
    (m): m is Extract<OutgoingMessage, { type: 'message'; msgType: 'slash_response' }> =>
      m.type === 'message' && (m as any).msgType === 'slash_response',
  );
}

describe('Claude handleSlashCommand', () => {
  it('always returns pass-through (SDK handles natively)', async () => {
    const backend = createClaudeBackend();
    expect(backend.handleSlashCommand).toBeDefined();
    const cases = [
      ['compact', ''],
      ['clear', ''],
      ['model', 'sonnet'],
      ['unknown', 'foo'],
    ];
    for (const [cmd, args] of cases) {
      const { send } = makeSendCapture();
      const result = await backend.handleSlashCommand!(cmd, args, send);
      expect(result).toEqual({ type: 'pass-through' });
    }
    backend.dispose();
  });
});

describe('Copilot handleSlashCommand', () => {
  it('/clear without prior session emits slash_response success and returns handled', async () => {
    // Regression: eager-rebuild /clear must skip ensureSession when there's
    // no session to actually clear, so unit tests / fresh agent-servers
    // don't get tripped up by missing Copilot CLI / gh auth.
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    const result = await backend.handleSlashCommand!('clear', '', send);
    expect(result).toEqual({ type: 'handled' });
    const responses = pickSlashResponses(emitted);
    // Pending first, then success.
    expect(responses.length).toBe(2);
    expect(responses[0].status).toBe('pending');
    expect(responses[1].status).toBe('success');
    expect(responses[1].content).toMatch(/cleared/i);
    expect(responses[0].slashCmd).toBe('clear');
    expect(responses[0].msgId).toBe(responses[1].msgId); // upsert pairing
    backend.dispose();
  });

  it('/help emits slash_response success listing commands', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    const result = await backend.handleSlashCommand!('help', '', send);
    expect(result).toEqual({ type: 'handled' });
    const responses = pickSlashResponses(emitted);
    // /help is synchronous — single success emission, no pending.
    expect(responses.length).toBe(1);
    expect(responses[0].status).toBe('success');
    expect(responses[0].slashCmd).toBe('help');
    expect(responses[0].content).toContain('/model');
    expect(responses[0].content).toContain('/clear');
    expect(responses[0].content).toContain('/compact');
    expect(responses[0].content).toContain('/context');
    expect(responses[0].content).toContain('/help');
    backend.dispose();
  });

  it('/context emits slash_response error when no usage tracked yet', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    const result = await backend.handleSlashCommand!('context', '', send);
    expect(result).toEqual({ type: 'handled' });
    const responses = pickSlashResponses(emitted);
    expect(responses.length).toBe(2);
    expect(responses[0].status).toBe('pending');
    expect(responses[1].status).toBe('error');
    expect(responses[1].content).toMatch(/no context info/i);
    backend.dispose();
  });

  it('/compact before any session emits slash_response error', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    const result = await backend.handleSlashCommand!('compact', '', send);
    expect(result).toEqual({ type: 'handled' });
    const responses = pickSlashResponses(emitted);
    expect(responses.length).toBe(2);
    expect(responses[0].status).toBe('pending');
    expect(responses[1].status).toBe('error');
    expect(responses[1].content).toMatch(/no active session/i);
    backend.dispose();
  });

  it('unknown command emits slash_response error', async () => {
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    const result = await backend.handleSlashCommand!('foobar', '', send);
    expect(result).toEqual({ type: 'handled' });
    const responses = pickSlashResponses(emitted);
    expect(responses.length).toBe(1);
    expect(responses[0].status).toBe('error');
    expect(responses[0].content).toContain('foobar');
    backend.dispose();
  });
});
