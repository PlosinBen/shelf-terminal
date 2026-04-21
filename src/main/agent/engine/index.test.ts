import { describe, it, expect } from 'vitest';
import { createEngine } from './index';
import type { AgentEvent } from '../types';

/**
 * These tests only exercise the sessionId plumbing — the parts of query()
 * that run before the first network call. We drive the generator just far
 * enough to observe the initial status event, then close it. No OpenAI
 * mock needed.
 */

function makeEngine() {
  return createEngine({
    apiKey: 'dummy',
    defaultModel: 'gpt-4',
    providerName: 'test-engine',
    // No tokenProvider, no toolExecutor — we never reach the network stage.
  });
}

async function firstStatus(engine: ReturnType<typeof makeEngine>, prompt: string, opts?: { resume?: string }) {
  const gen = engine.query(prompt, '/tmp', opts);
  let status: AgentEvent | null = null;
  for await (const ev of gen) {
    if (ev.type === 'status') {
      status = ev;
      break;
    }
  }
  // Close the generator so the engine's abort controller / cleanup runs.
  await gen.return?.(undefined);
  return status;
}

describe('engine sessionId plumbing', () => {
  it('mints a fresh sessionId on first query when no resume is passed', async () => {
    const engine = makeEngine();
    const status = await firstStatus(engine, 'hello');
    expect(status?.type).toBe('status');
    const payload = status?.type === 'status' ? status.payload : null;
    // UUID v4 format — just assert non-empty string that looks like a UUID.
    expect(payload?.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('reuses the same sessionId on subsequent queries within the same engine instance', async () => {
    const engine = makeEngine();
    const first = await firstStatus(engine, 'hello');
    const second = await firstStatus(engine, 'follow-up');
    const firstId = first?.type === 'status' ? first.payload.sessionId : null;
    const secondId = second?.type === 'status' ? second.payload.sessionId : null;
    expect(firstId).toBeTruthy();
    expect(secondId).toBe(firstId);
  });

  it('adopts an external resume id instead of minting a new one', async () => {
    const engine = makeEngine();
    const externalId = '11111111-2222-3333-4444-555555555555';
    const status = await firstStatus(engine, 'hello', { resume: externalId });
    const payload = status?.type === 'status' ? status.payload : null;
    expect(payload?.sessionId).toBe(externalId);
  });

  it('external resume overrides a previously held id on a later turn', async () => {
    const engine = makeEngine();
    await firstStatus(engine, 'first turn'); // engine mints an internal id
    const overrideId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const after = await firstStatus(engine, 'second turn', { resume: overrideId });
    const payload = after?.type === 'status' ? after.payload : null;
    // Last caller-supplied resume wins — important because the session
    // manager passes session.sdkSessionId every turn, and that's the
    // single source of truth across restarts.
    expect(payload?.sessionId).toBe(overrideId);
  });

  it('clearHistory() drops the sessionId so the next query mints a new one', async () => {
    const engine = makeEngine();
    const before = await firstStatus(engine, 'hello');
    const beforeId = before?.type === 'status' ? before.payload.sessionId : null;
    expect(beforeId).toBeTruthy();

    engine.clearHistory();

    const after = await firstStatus(engine, 'hello again');
    const afterId = after?.type === 'status' ? after.payload.sessionId : null;
    expect(afterId).toBeTruthy();
    expect(afterId).not.toBe(beforeId);
  });
});
