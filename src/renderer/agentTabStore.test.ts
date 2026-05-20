import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentMsg } from './components/AgentMessage';

// Mock the IDB storage module — we don't want real IndexedDB calls,
// and we need to control load/save timing for race tests.
const mockedStorage = vi.hoisted(() => ({
  loadAgentMessages: vi.fn<(sessionId: string) => Promise<AgentMsg[]>>(),
  saveAgentMessages: vi.fn<(sessionId: string, msgs: AgentMsg[], max: number) => Promise<void>>(),
  clearAgentSession: vi.fn<(sessionId: string) => Promise<void>>(),
}));
vi.mock('./storage/agent-history', () => mockedStorage);

import {
  initTab,
  removeTab,
  upsertMessage,
  appendChunk,
  enqueueMessage,
  dequeueMessage,
  cancelQueuedMessage,
  clearMessages,
  setStreaming,
  setStatus,
  setPlan,
  setCapabilities,
  setActualModel,
  setActualEffort,
  setActualPermissionMode,
  setPendingPermission,
  setPendingPicker,
  setLocalPicker,
  setAuthRequired,
  setInitStatus,
  setInMemoryMax,
  setIdbMax,
  setSaveThrottleMs,
  buildTurns,
  __resetStoreForTests,
  __getCapsForTests,
  __getTabForTests,
  __getPendingSaveForTests,
} from './agentTabStore';

const TAB = 'tab-1';
const SESSION = 'sess-1';

function textMsg(id: string, content: string, streaming = false): AgentMsg {
  return { id, type: 'text', content, streaming, provider: 'claude', timestamp: 1000 };
}

function userMsg(id: string, content: string): AgentMsg {
  return { id, type: 'user', content, timestamp: 1000 };
}

beforeEach(() => {
  __resetStoreForTests();
  mockedStorage.loadAgentMessages.mockReset().mockResolvedValue([]);
  mockedStorage.saveAgentMessages.mockReset().mockResolvedValue();
  mockedStorage.clearAgentSession.mockReset().mockResolvedValue();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('agentTabStore — lifecycle', () => {
  it('initTab creates a slice and is idempotent', () => {
    initTab(TAB, { sessionId: SESSION, provider: 'claude' });
    const tab = __getTabForTests(TAB);
    expect(tab).toBeDefined();
    expect(tab!.sessionId).toBe(SESSION);
    expect(tab!.messages).toEqual([]);

    initTab(TAB, { sessionId: 'other', provider: 'copilot' });  // no-op
    expect(__getTabForTests(TAB)!.sessionId).toBe(SESSION);
  });

  it('warm-starts actual* from intent', () => {
    initTab(TAB, {
      sessionId: SESSION,
      provider: 'claude',
      intent: { model: 'opus', effort: 'high', permissionMode: 'plan' },
    });
    const tab = __getTabForTests(TAB)!;
    expect(tab.actualModel).toBe('opus');
    expect(tab.actualEffort).toBe('high');
    expect(tab.actualPermissionMode).toBe('plan');
  });

  it('removeTab clears slice, listeners, and flushes pending save', async () => {
    initTab(TAB, { sessionId: SESSION, provider: 'claude' });
    upsertMessage(TAB, textMsg('m1', 'hello'));
    expect(__getPendingSaveForTests(TAB)).toBeDefined();
    removeTab(TAB);
    expect(__getTabForTests(TAB)).toBeUndefined();
    expect(__getPendingSaveForTests(TAB)).toBeUndefined();
    // flushSave fires synchronously inside removeTab. saveAgentMessages
    // is called but returns a promise — let microtasks settle.
    expect(mockedStorage.saveAgentMessages).toHaveBeenCalledTimes(1);
  });
});

describe('agentTabStore — IDB load merge (race-safe)', () => {
  it('merges loaded behind current messages, preserving in-flight events', async () => {
    let resolveLoad!: (msgs: AgentMsg[]) => void;
    mockedStorage.loadAgentMessages.mockReturnValue(new Promise<AgentMsg[]>((r) => { resolveLoad = r; }));
    initTab(TAB, { sessionId: SESSION, provider: 'claude' });
    // Backend event arrives before load resolves
    upsertMessage(TAB, textMsg('m-live', 'live'));
    // Now load resolves with old history
    resolveLoad([textMsg('m-old1', 'old1'), textMsg('m-old2', 'old2')]);
    await vi.waitFor(() => {
      expect(__getTabForTests(TAB)!.messages.length).toBe(3);
    });
    const ids = __getTabForTests(TAB)!.messages.map((m) => m.id);
    expect(ids).toEqual(['m-old1', 'm-old2', 'm-live']);
  });

  it('ID-conflict between loaded and current → keeps current', async () => {
    let resolveLoad!: (msgs: AgentMsg[]) => void;
    mockedStorage.loadAgentMessages.mockReturnValue(new Promise<AgentMsg[]>((r) => { resolveLoad = r; }));
    initTab(TAB, { sessionId: SESSION, provider: 'claude' });
    upsertMessage(TAB, textMsg('m-shared', 'new-version'));
    resolveLoad([textMsg('m-shared', 'old-version')]);
    await vi.waitFor(() => {
      const msgs = __getTabForTests(TAB)!.messages;
      expect(msgs.length).toBe(1);
      expect((msgs[0] as any).content).toBe('new-version');
    });
  });

  it('load failure does not crash; messages stays as-is', async () => {
    mockedStorage.loadAgentMessages.mockRejectedValueOnce(new Error('idb gone'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    initTab(TAB, { sessionId: SESSION, provider: 'claude' });
    upsertMessage(TAB, textMsg('m1', 'live'));
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalled());
    expect(__getTabForTests(TAB)!.messages.length).toBe(1);
    errSpy.mockRestore();
  });
});

describe('agentTabStore — message actions', () => {
  beforeEach(() => initTab(TAB, { sessionId: SESSION, provider: 'claude' }));

  it('upsertMessage appends new and replaces existing by id', () => {
    upsertMessage(TAB, textMsg('m1', 'v1'));
    upsertMessage(TAB, textMsg('m2', 'v2'));
    upsertMessage(TAB, textMsg('m1', 'v1-updated'));
    const msgs = __getTabForTests(TAB)!.messages;
    expect(msgs.length).toBe(2);
    expect((msgs[0] as any).content).toBe('v1-updated');
  });

  it('appendChunk creates streaming placeholder then appends delta', () => {
    appendChunk(TAB, 'chunk-1', 'Hello ', 'text');
    appendChunk(TAB, 'chunk-1', 'world', 'text');
    const msgs = __getTabForTests(TAB)!.messages;
    expect(msgs.length).toBe(1);
    expect((msgs[0] as any).content).toBe('Hello world');
    expect((msgs[0] as any).streaming).toBe(true);
  });

  it('appendChunk does NOT requestSave (skips during streaming)', () => {
    appendChunk(TAB, 'chunk-1', 'hi', 'text');
    expect(__getPendingSaveForTests(TAB)).toBeUndefined();
  });

  it('enqueue/dequeue/cancelQueuedMessage', () => {
    enqueueMessage(TAB, 'A');
    enqueueMessage(TAB, 'B');
    expect(__getTabForTests(TAB)!.queuedMessages.length).toBe(2);
    const first = dequeueMessage(TAB);
    expect(first!.content).toBe('A');
    expect(__getTabForTests(TAB)!.queuedMessages.length).toBe(1);
    const remaining = __getTabForTests(TAB)!.queuedMessages[0];
    cancelQueuedMessage(TAB, remaining.id);
    expect(__getTabForTests(TAB)!.queuedMessages.length).toBe(0);
  });

  it('clearMessages flushes pending and calls clearAgentSession', async () => {
    upsertMessage(TAB, textMsg('m1', 'hi'));
    await clearMessages(TAB);
    expect(__getTabForTests(TAB)!.messages.length).toBe(0);
    expect(mockedStorage.clearAgentSession).toHaveBeenCalledWith(SESSION);
  });
});

describe('agentTabStore — status / capabilities (no-fallback semantics)', () => {
  beforeEach(() => initTab(TAB, {
    sessionId: SESSION,
    provider: 'claude',
    intent: { model: 'opus', effort: 'high', permissionMode: 'plan' },
  }));

  it('setCapabilities overwrites actual* from backend report; does NOT read intent', () => {
    setCapabilities(TAB, {
      models: [], permissionModes: [], effortLevels: [], slashCommands: [],
      currentModel: 'sonnet',        // backend reports fallback model
      currentEffort: 'medium',
      currentPermissionMode: 'default',
    });
    const tab = __getTabForTests(TAB)!;
    expect(tab.actualModel).toBe('sonnet');     // not 'opus' (intent)
    expect(tab.actualEffort).toBe('medium');
    expect(tab.actualPermissionMode).toBe('default');
  });

  it('setCapabilities without currentX keeps prior actual', () => {
    setActualModel(TAB, 'haiku');
    setCapabilities(TAB, { models: [], permissionModes: [], effortLevels: [], slashCommands: [] });
    expect(__getTabForTests(TAB)!.actualModel).toBe('haiku');
  });

  it('setStatus updates fields and respects model overwrite', () => {
    setStatus(TAB, { costUsd: 0.05, numTurns: 3, model: 'sonnet' });
    const tab = __getTabForTests(TAB)!;
    expect(tab.costUsd).toBe(0.05);
    expect(tab.numTurns).toBe(3);
    expect(tab.actualModel).toBe('sonnet');
  });
});

describe('agentTabStore — streaming transitions', () => {
  beforeEach(() => initTab(TAB, { sessionId: SESSION, provider: 'claude' }));

  it('setStreaming(false) clears streaming flag on in-flight text', () => {
    appendChunk(TAB, 'm1', 'hi', 'text');
    setStreaming(TAB, true);
    setStreaming(TAB, false);
    const m = __getTabForTests(TAB)!.messages[0] as any;
    expect(m.streaming).toBe(false);
  });

  it('setStreaming(false) clears pendingPicker (ghost panel guard)', () => {
    setStreaming(TAB, true);
    setPendingPicker(TAB, { id: 'p1', prompts: [] });
    setStreaming(TAB, false);
    expect(__getTabForTests(TAB)!.pendingPicker).toBeNull();
  });

  it('streaming flag transition true→false triggers requestSave', () => {
    setStreaming(TAB, true);
    setStreaming(TAB, false);
    expect(__getPendingSaveForTests(TAB)).toBeDefined();
  });
});

describe('agentTabStore — save throttle', () => {
  beforeEach(() => initTab(TAB, { sessionId: SESSION, provider: 'claude' }));

  it('multiple requestSave within window coalesce into one save', async () => {
    upsertMessage(TAB, textMsg('m1', 'a'));
    upsertMessage(TAB, textMsg('m2', 'b'));
    upsertMessage(TAB, textMsg('m3', 'c'));
    expect(mockedStorage.saveAgentMessages).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5001);
    expect(mockedStorage.saveAgentMessages).toHaveBeenCalledTimes(1);
  });

  it('streaming-in-progress skips doSave (deferred to turn end)', () => {
    setStreaming(TAB, true);
    upsertMessage(TAB, textMsg('m1', 'mid-stream'));
    vi.advanceTimersByTime(5001);
    expect(mockedStorage.saveAgentMessages).not.toHaveBeenCalled();
  });

  it('removeTab flushes pending save synchronously', () => {
    upsertMessage(TAB, textMsg('m1', 'hi'));
    removeTab(TAB);
    expect(mockedStorage.saveAgentMessages).toHaveBeenCalledTimes(1);
  });
});

describe('agentTabStore — in-memory trim', () => {
  beforeEach(() => {
    setInMemoryMax(5);
    setIdbMax(10);
    initTab(TAB, { sessionId: SESSION, provider: 'claude' });
  });

  it('doSave trims messages to inMemoryMax', () => {
    for (let i = 0; i < 8; i++) upsertMessage(TAB, textMsg(`m${i}`, `c${i}`));
    vi.advanceTimersByTime(5001);
    expect(__getTabForTests(TAB)!.messages.length).toBe(5);
    expect(__getTabForTests(TAB)!.messages[0].id).toBe('m3');  // oldest kept
  });

  it('saveAgentMessages is called with idbMax (independent from inMemoryMax)', () => {
    for (let i = 0; i < 3; i++) upsertMessage(TAB, textMsg(`m${i}`, `c${i}`));
    vi.advanceTimersByTime(5001);
    const call = mockedStorage.saveAgentMessages.mock.calls[0];
    expect(call[2]).toBe(10);  // idbMax
  });

  it('streaming-in-progress does NOT trim', () => {
    setStreaming(TAB, true);
    for (let i = 0; i < 8; i++) upsertMessage(TAB, textMsg(`m${i}`, `c${i}`));
    vi.advanceTimersByTime(5001);
    expect(__getTabForTests(TAB)!.messages.length).toBe(8);
  });
});

describe('agentTabStore — settings constraints', () => {
  it('setInMemoryMax clamps to idbMax', () => {
    setIdbMax(100);
    setInMemoryMax(200);
    expect(__getCapsForTests().inMemoryMax).toBe(100);
  });

  it('setIdbMax lowering below inMemoryMax re-clamps inMemoryMax', () => {
    setInMemoryMax(500);
    setIdbMax(1000);
    expect(__getCapsForTests().inMemoryMax).toBe(500);
    setIdbMax(300);
    expect(__getCapsForTests().inMemoryMax).toBe(300);
  });

  it('setSaveThrottleMs floors at 0', () => {
    setSaveThrottleMs(-10);
    expect(__getCapsForTests().saveThrottleMs).toBe(0);
  });
});

describe('agentTabStore — buildTurns selector', () => {
  it('groups orphan agent msgs into a leading agent-only turn', () => {
    const msgs: AgentMsg[] = [
      textMsg('m1', 'sys boot'),
      userMsg('u1', 'hi'),
      textMsg('m2', 'response'),
    ];
    const turns = buildTurns(msgs);
    expect(turns.length).toBe(2);
    expect(turns[0].user).toBeUndefined();
    expect(turns[0].agent.length).toBe(1);
    expect(turns[1].user?.id).toBe('u1');
    expect(turns[1].agent.length).toBe(1);
  });

  it('opens a new turn on every user message', () => {
    const msgs: AgentMsg[] = [
      userMsg('u1', 'A'),
      textMsg('m1', 'a-reply'),
      userMsg('u2', 'B'),
      textMsg('m2', 'b-reply'),
    ];
    const turns = buildTurns(msgs);
    expect(turns.length).toBe(2);
    expect(turns[0].user?.id).toBe('u1');
    expect(turns[1].user?.id).toBe('u2');
  });
});

describe('agentTabStore — decisions / auth / init', () => {
  beforeEach(() => initTab(TAB, { sessionId: SESSION, provider: 'claude' }));

  it('setPendingPermission / setPendingPicker / setLocalPicker', () => {
    setPendingPermission(TAB, { toolUseId: 'tu1', toolName: 'Bash', input: {} });
    expect(__getTabForTests(TAB)!.pendingPermission?.toolUseId).toBe('tu1');
    setPendingPicker(TAB, { id: 'p1', prompts: [] });
    expect(__getTabForTests(TAB)!.pendingPicker?.id).toBe('p1');
    setLocalPicker(TAB, { key: 'model' });
    expect(__getTabForTests(TAB)!.localPicker?.key).toBe('model');
  });

  it('setAuthRequired / setInitStatus', () => {
    setAuthRequired(TAB, { provider: 'claude' });
    expect(__getTabForTests(TAB)!.authRequired?.provider).toBe('claude');
    setInitStatus(TAB, 'failed', 'no creds');
    expect(__getTabForTests(TAB)!.initStatus).toBe('failed');
    expect(__getTabForTests(TAB)!.initError).toBe('no creds');
  });

  it('setPlan / setActual*', () => {
    setPlan(TAB, '## Plan');
    expect(__getTabForTests(TAB)!.currentPlan).toBe('## Plan');
    setActualModel(TAB, 'opus');
    setActualEffort(TAB, 'high');
    setActualPermissionMode(TAB, 'plan');
    const tab = __getTabForTests(TAB)!;
    expect(tab.actualModel).toBe('opus');
    expect(tab.actualEffort).toBe('high');
    expect(tab.actualPermissionMode).toBe('plan');
  });
});
