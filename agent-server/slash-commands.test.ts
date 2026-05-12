import { describe, it, expect } from 'vitest';
import { createCopilotBackend } from './providers/copilot';
import type { OutgoingMessage, SendFn, QueryInput } from './providers/types';

/**
 * Test helper — captures all messages emitted by the provider via the wire
 * send fn. Slash commands now flow through `query()` (post-step-11): provider
 * parses the prefix internally and dispatches via dispatchSlash without
 * touching SDK for the migrated commands.
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

function makeQueryInput(prompt: string): QueryInput {
  return { prompt, cwd: '/tmp' };
}

describe('Copilot slash dispatch via query()', () => {
  it('/clear without prior session emits slash_response pending → success', async () => {
    // Regression: eager-rebuild /clear must skip ensureSession when there's
    // no session to actually clear, so unit tests / fresh agent-servers
    // don't get tripped up by missing Copilot CLI / gh auth.
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/clear'), send);
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
    await backend.query(makeQueryInput('/help'), send);
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
    await backend.query(makeQueryInput('/context'), send);
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
    await backend.query(makeQueryInput('/compact'), send);
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
    await backend.query(makeQueryInput('/foobar'), send);
    const responses = pickSlashResponses(emitted);
    expect(responses.length).toBe(1);
    expect(responses[0].status).toBe('error');
    expect(responses[0].content).toContain('foobar');
    backend.dispose();
  });

  it('emits streaming → idle status pair around slash dispatch (no cost/tokens on slash idle)', async () => {
    // Slash turn lifecycle parity with normal turns — renderer's isStreaming
    // gate flips on streaming and off on idle. Slash idle must NOT carry
    // cost / tokens / numTurns / contextUsage so the renderer's status bar
    // keeps the last real turn's values.
    const backend = createCopilotBackend();
    const { send, emitted } = makeSendCapture();
    await backend.query(makeQueryInput('/help'), send);
    const statusEvents = emitted.filter((m) => m.type === 'status') as Extract<OutgoingMessage, { type: 'status' }>[];
    expect(statusEvents.length).toBe(2);
    expect(statusEvents[0].state).toBe('streaming');
    expect(statusEvents[1].state).toBe('idle');
    // The idle payload from the slash path should carry only state — no
    // numeric metrics that would overwrite the last real turn's values.
    expect(statusEvents[1].costUsd).toBeUndefined();
    expect(statusEvents[1].inputTokens).toBeUndefined();
    expect(statusEvents[1].numTurns).toBeUndefined();
    expect(statusEvents[1].contextUsage).toBeUndefined();
    backend.dispose();
  });

});

