import { describe, it, expect, vi } from 'vitest';
import { createEngine, type Message } from './index';
import type { AgentEvent } from '../types';
import type { HistoryStore, EngineHistory } from './history-store';

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

describe('engine historyStore integration', () => {
  /** In-memory HistoryStore stub — lets us verify engine calls without touching disk. */
  function makeStore(seed?: EngineHistory): HistoryStore & { saves: EngineHistory[]; deletes: string[] } {
    const state = new Map<string, EngineHistory>();
    if (seed) state.set(seed.sessionId, seed);
    const saves: EngineHistory[] = [];
    const deletes: string[] = [];
    return {
      load: vi.fn(async (id: string) => state.get(id) ?? null),
      save: vi.fn(async (entry: EngineHistory) => {
        saves.push(structuredClone(entry));
        state.set(entry.sessionId, entry);
      }),
      delete: vi.fn(async (id: string) => {
        deletes.push(id);
        state.delete(id);
      }),
      saves,
      deletes,
    } as any;
  }

  it('loads prior history from the store on first query with a resume id', async () => {
    const priorMessages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello back' },
    ];
    const store = makeStore({
      version: 1,
      sessionId: 'resume-me',
      providerName: 'test-engine',
      messages: priorMessages,
      createdAt: 1,
      updatedAt: 2,
    });
    const engine = createEngine({
      apiKey: 'dummy',
      defaultModel: 'gpt-4',
      providerName: 'test-engine',
      historyStore: store,
    });

    // Drive the engine just past the load step.
    const gen = engine.query('follow up', '/tmp', { resume: 'resume-me' });
    for await (const ev of gen) {
      if (ev.type === 'status') break;
    }
    await gen.return?.(undefined);

    expect(store.load).toHaveBeenCalledWith('resume-me');
    // History should now contain restored messages (plus the just-added
    // user turn + system prompt). Check that the restored ones survived.
    const hist = engine.getHistory();
    expect(hist).toEqual(expect.arrayContaining(priorMessages));
  });

  it('loads at most once per session (subsequent turns hit memory)', async () => {
    const store = makeStore();
    const engine = createEngine({
      apiKey: 'dummy',
      defaultModel: 'gpt-4',
      providerName: 'test-engine',
      historyStore: store,
    });

    for (let i = 0; i < 3; i++) {
      const gen = engine.query(`turn ${i}`, '/tmp');
      for await (const ev of gen) { if (ev.type === 'status') break; }
      await gen.return?.(undefined);
    }

    expect(store.load).toHaveBeenCalledTimes(1);
  });

  it('deletes the persisted file when clearHistory() is called', async () => {
    const store = makeStore();
    const engine = createEngine({
      apiKey: 'dummy',
      defaultModel: 'gpt-4',
      providerName: 'test-engine',
      historyStore: store,
    });

    // First query to mint a sessionId so there's something to delete.
    const gen = engine.query('hello', '/tmp');
    let seenId: string | undefined;
    for await (const ev of gen) {
      if (ev.type === 'status') {
        seenId = ev.payload.sessionId;
        break;
      }
    }
    await gen.return?.(undefined);
    expect(seenId).toBeTruthy();

    engine.clearHistory();

    // delete is fire-and-forget (.catch swallowed); await a tick so the
    // microtask fires.
    await new Promise((r) => setImmediate(r));
    expect(store.delete).toHaveBeenCalledWith(seenId);
  });

  it('load failure is swallowed — engine continues with empty history', async () => {
    const store = makeStore();
    store.load = vi.fn(async () => {
      throw new Error('disk on fire');
    });
    const engine = createEngine({
      apiKey: 'dummy',
      defaultModel: 'gpt-4',
      providerName: 'test-engine',
      historyStore: store,
    });

    // A buggy adapter must not eat the user's turn. Engine should log
    // and carry on as if there was nothing to restore.
    const gen = engine.query('hello', '/tmp', { resume: 'some-id' });
    let status: AgentEvent | null = null;
    for await (const ev of gen) { if (ev.type === 'status') { status = ev; break; } }
    await gen.return?.(undefined);

    expect(status?.type).toBe('status');
    expect(store.load).toHaveBeenCalledTimes(1);
    // History starts blank — only the system prompt + the new user turn
    // the engine itself appended.
    const hist = engine.getHistory();
    expect(hist.find((m) => m.role === 'user' && m.content === 'hello')).toBeTruthy();
    expect(hist.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });
});
