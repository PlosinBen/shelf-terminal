import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentMsg } from './components/AgentMessage';

// Mock the IDB storage module — we don't want real IndexedDB calls,
// and we need to control load/save timing for race tests.
const mockedStorage = vi.hoisted(() => ({
  loadAgentMessagesLatest: vi.fn<(sessionId: string, limit: number) => Promise<AgentMsg[]>>(),
  saveAgentMessagesDelta: vi.fn<(sessionId: string, dirty: AgentMsg[], deleted?: Set<string>) => Promise<void>>(),
  clearAgentSession: vi.fn<(sessionId: string) => Promise<void>>(),
}));
vi.mock('./storage/agent-history', () => mockedStorage);

import {
  initTab,
  removeTab,
  upsertMessage,
  appendChunk,
  enqueuePendingSend,
  applyQueueSnapshot,
  cancelPendingSend,
  clearPendingSends,
  clearMessages,
  setStreaming,
  setStatus,
  setPlan,
  applyTaskEvent,
  removeBackgroundTask,
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
  setSaveThrottleMs,
  buildTurns,
  __resetStoreForTests,
  __getCapsForTests,
  __getTabForTests,
  __getPendingSaveForTests,
  __subscribeForTests,
} from './agentTabStore';

const TAB = 'tab-1';
const SESSION = 'sess-1';

function textMsg(id: string, content: string, streaming = false): AgentMsg {
  return { id, type: 'reply', content, streaming, provider: 'claude', timestamp: 1000 };
}

function userMsg(id: string, content: string): AgentMsg {
  return { id, type: 'user', content, timestamp: 1000 };
}

beforeEach(() => {
  __resetStoreForTests();
  mockedStorage.loadAgentMessagesLatest.mockReset().mockResolvedValue([]);
  mockedStorage.saveAgentMessagesDelta.mockReset().mockResolvedValue();
  mockedStorage.clearAgentSession.mockReset().mockResolvedValue();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('agentTabStore — applyTaskEvent (background tasks)', () => {
  beforeEach(() => initTab(TAB, { sessionId: SESSION, provider: 'claude' }));

  const task = (id: string, over: Partial<import('../shared/types').NormalizedTask> = {}) => ({
    id, type: 'shell' as const, label: id, status: 'running' as const, done: false, ...over,
  });

  it('started → adds a running task', () => {
    applyTaskEvent(TAB, { kind: 'started', task: task('t1') });
    expect(__getTabForTests(TAB)!.backgroundTasks).toEqual([task('t1')]);
  });

  it('upserts by id (later event replaces, preserving position)', () => {
    applyTaskEvent(TAB, { kind: 'started', task: task('t1') });
    applyTaskEvent(TAB, { kind: 'started', task: task('t2') });
    applyTaskEvent(TAB, { kind: 'done', task: task('t1', { status: 'completed', done: true, summary: 'ok' }) });
    const bg = __getTabForTests(TAB)!.backgroundTasks;
    expect(bg.map((t) => t.id)).toEqual(['t1', 't2']); // order preserved
    expect(bg[0]).toMatchObject({ id: 't1', status: 'completed', done: true, summary: 'ok' });
  });

  it('snapshot upserts running tasks without dropping already-completed ones', () => {
    applyTaskEvent(TAB, { kind: 'done', task: task('t0', { status: 'completed', done: true }) });
    applyTaskEvent(TAB, { kind: 'snapshot', tasks: [task('t1'), task('t2')] });
    const bg = __getTabForTests(TAB)!.backgroundTasks;
    expect(bg.map((t) => t.id)).toEqual(['t0', 't1', 't2']);
    expect(bg[0].done).toBe(true); // completed task survived the snapshot
  });

  it('ignores empty events (no task / empty snapshot)', () => {
    applyTaskEvent(TAB, { kind: 'started', task: task('t1') });
    applyTaskEvent(TAB, { kind: 'snapshot', tasks: [] });
    applyTaskEvent(TAB, { kind: 'updated' });
    expect(__getTabForTests(TAB)!.backgroundTasks).toEqual([task('t1')]);
  });

  it('removeBackgroundTask dismisses a single task by id', () => {
    applyTaskEvent(TAB, { kind: 'started', task: task('t1') });
    applyTaskEvent(TAB, { kind: 'started', task: task('t2') });
    removeBackgroundTask(TAB, 't1');
    expect(__getTabForTests(TAB)!.backgroundTasks.map((t) => t.id)).toEqual(['t2']);
    // Removing an unknown id is a no-op (no throw, no change).
    removeBackgroundTask(TAB, 'nope');
    expect(__getTabForTests(TAB)!.backgroundTasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('tombstones a removed id — a later task_notification cannot resurrect it', () => {
    applyTaskEvent(TAB, { kind: 'started', task: task('t1') });
    removeBackgroundTask(TAB, 't1');
    // The SDK's 'stopped' echo (and any turn-boundary snapshot) arrives AFTER
    // the user deleted the card — it must not re-add it.
    applyTaskEvent(TAB, { kind: 'done', task: task('t1', { status: 'stopped', done: true }) });
    applyTaskEvent(TAB, { kind: 'snapshot', tasks: [task('t1')] });
    expect(__getTabForTests(TAB)!.backgroundTasks).toEqual([]);
  });

  it('clearMessages resets the tombstone (a reused id can appear again)', async () => {
    applyTaskEvent(TAB, { kind: 'started', task: task('t1') });
    removeBackgroundTask(TAB, 't1');
    await clearMessages(TAB);
    applyTaskEvent(TAB, { kind: 'started', task: task('t1') });
    expect(__getTabForTests(TAB)!.backgroundTasks.map((t) => t.id)).toEqual(['t1']);
  });

  it('clearMessages also clears background tasks (session wiped)', async () => {
    applyTaskEvent(TAB, { kind: 'started', task: task('t1') });
    await clearMessages(TAB);
    expect(__getTabForTests(TAB)!.backgroundTasks).toEqual([]);
  });
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
    // flushSave fires synchronously inside removeTab.
    expect(mockedStorage.saveAgentMessagesDelta).toHaveBeenCalledTimes(1);
  });
});

describe('agentTabStore — IDB load merge (race-safe)', () => {
  it('merges loaded behind current messages, preserving in-flight events', async () => {
    let resolveLoad!: (msgs: AgentMsg[]) => void;
    mockedStorage.loadAgentMessagesLatest.mockReturnValue(new Promise<AgentMsg[]>((r) => { resolveLoad = r; }));
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
    mockedStorage.loadAgentMessagesLatest.mockReturnValue(new Promise<AgentMsg[]>((r) => { resolveLoad = r; }));
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
    mockedStorage.loadAgentMessagesLatest.mockRejectedValueOnce(new Error('idb gone'));
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

  it('appendChunk buffers deltas and flushes after the 33ms window', () => {
    appendChunk(TAB, 'chunk-1', 'Hello ', 'text');
    appendChunk(TAB, 'chunk-1', 'world', 'text');
    // Before the timer fires, messages is still empty — deltas live
    // in the chunk buffer, not in the store slice.
    expect(__getTabForTests(TAB)!.messages.length).toBe(0);

    vi.advanceTimersByTime(33);

    const msgs = __getTabForTests(TAB)!.messages;
    expect(msgs.length).toBe(1);
    expect((msgs[0] as any).content).toBe('Hello world');
    expect((msgs[0] as any).streaming).toBe(true);
  });

  it('appendChunk coalesces multiple chunks into a single notify', () => {
    let notifyCount = 0;
    const unsub = __subscribeForTests(TAB, () => { notifyCount += 1; });
    for (let i = 0; i < 10; i++) appendChunk(TAB, 'chunk-1', 'x', 'text');
    expect(notifyCount).toBe(0);  // nothing flushed yet
    vi.advanceTimersByTime(33);
    expect(notifyCount).toBe(1);  // ten chunks → one re-render
    unsub();
  });

  it('appendChunk for separate msgIds in same window merges into one flush', () => {
    appendChunk(TAB, 'm1', 'A', 'text');
    appendChunk(TAB, 'm2', 'B', 'thinking');
    vi.advanceTimersByTime(33);
    const msgs = __getTabForTests(TAB)!.messages;
    expect(msgs.length).toBe(2);
    expect(msgs.find((m) => m.id === 'm1')).toBeDefined();
    expect(msgs.find((m) => m.id === 'm2')).toBeDefined();
  });

  it('appendChunk does NOT requestSave (skips during streaming)', () => {
    appendChunk(TAB, 'chunk-1', 'hi', 'text');
    vi.advanceTimersByTime(33);
    expect(__getPendingSaveForTests(TAB)).toBeUndefined();
  });

  it('setStreaming(false) flushes pending chunks before clearing streaming flag', () => {
    setStreaming(TAB, true);
    appendChunk(TAB, 'chunk-1', 'pending', 'text');
    // Buffer not yet flushed
    expect(__getTabForTests(TAB)!.messages.length).toBe(0);
    setStreaming(TAB, false);
    // Flushed synchronously by setStreaming, AND the streaming flag
    // got cleared on the flushed entry in the same pass.
    const msgs = __getTabForTests(TAB)!.messages;
    expect(msgs.length).toBe(1);
    expect((msgs[0] as any).content).toBe('pending');
    expect((msgs[0] as any).streaming).toBe(false);
  });

  it('upsertMessage clears pending chunks for same msgId — fixes stream-finalize race (no trailing duplicate)', () => {
    // 模擬 race：finalize message 在 33ms timer 觸發前抵達。
    // Buffer 內未 flush 的 delta 已經包含在 finalize content 內，不該再追加。
    appendChunk(TAB, 'm1', '可以開', 'text');
    appendChunk(TAB, 'm1', '工。', 'text');
    // Buffer 還沒 flush
    expect(__getTabForTests(TAB)!.messages.length).toBe(0);

    // Finalize message 帶完整 content 抵達
    upsertMessage(TAB, textMsg('m1', '確認後寫進 plan 文件，五個 Q 全部完成可以開工。'));

    // 推進 timer — buffer 應該已被 upsertMessage 清掉，不該追加重複文字
    vi.advanceTimersByTime(33);

    const msgs = __getTabForTests(TAB)!.messages;
    expect(msgs.length).toBe(1);
    expect((msgs[0] as any).content).toBe('確認後寫進 plan 文件，五個 Q 全部完成可以開工。');
    // 修復前的 bug：content 會變成 '...可以開工。可以開工。'（buffer 追加）
  });

  it('upsertMessage only clears buffer for the same msgId — other msgIds untouched', () => {
    appendChunk(TAB, 'm1', 'foo', 'text');
    appendChunk(TAB, 'm2', 'bar', 'text');
    // 只 finalize m1
    upsertMessage(TAB, textMsg('m1', 'final-m1'));
    vi.advanceTimersByTime(33);

    const msgs = __getTabForTests(TAB)!.messages;
    expect(msgs.length).toBe(2);
    expect((msgs.find((m) => m.id === 'm1') as any).content).toBe('final-m1');
    // m2 沒被 finalize，buffer 仍正常 flush
    expect((msgs.find((m) => m.id === 'm2') as any).content).toBe('bar');
  });

  it('removeTab clears pending chunk buffer + timer', () => {
    appendChunk(TAB, 'chunk-1', 'lost', 'text');
    removeTab(TAB);
    // Tab gone — re-adding shouldn't see any zombie content from
    // the previous buffer.
    initTab(TAB, { sessionId: SESSION, provider: 'claude' });
    vi.advanceTimersByTime(33);
    expect(__getTabForTests(TAB)!.messages.length).toBe(0);
  });

  it('pending sends: optimistic chip → snapshot promotes to timeline', () => {
    enqueuePendingSend(TAB, 'cm-1', 'A');
    enqueuePendingSend(TAB, 'cm-2', 'B');
    expect(__getTabForTests(TAB)!.pendingSends.map((p) => p.clientMsgId)).toEqual(['cm-1', 'cm-2']);

    // Snapshot: cm-1 running, cm-2 queued → cm-1 promoted to a timeline user bubble.
    applyQueueSnapshot(TAB, [
      { clientMsgId: 'cm-1', state: 'running' },
      { clientMsgId: 'cm-2', state: 'queued' },
    ]);
    const tab = __getTabForTests(TAB)!;
    expect(tab.pendingSends.map((p) => p.clientMsgId)).toEqual(['cm-2']);
    const bubble = tab.messages.find((m) => m.id === 'user-cm-1');
    expect(bubble).toMatchObject({ type: 'user', content: 'A' });
  });

  it('pending sends: cancel removes the optimistic chip', () => {
    enqueuePendingSend(TAB, 'cm-1', 'A');
    enqueuePendingSend(TAB, 'cm-2', 'B');
    cancelPendingSend(TAB, 'cm-1');
    expect(__getTabForTests(TAB)!.pendingSends.map((p) => p.clientMsgId)).toEqual(['cm-2']);
    clearPendingSends(TAB);
    expect(__getTabForTests(TAB)!.pendingSends.length).toBe(0);
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

  it('setStatus updates metric fields but does NOT touch actualModel', () => {
    // Model display is capabilities-driven only — per-turn status must not
    // change actualModel (prevents alias flip-flop, see claude.ts).
    setActualModel(TAB, 'default');
    setStatus(TAB, { costUsd: 0.05, numTurns: 3 });
    const tab = __getTabForTests(TAB)!;
    expect(tab.costUsd).toBe(0.05);
    expect(tab.numTurns).toBe(3);
    expect(tab.actualModel).toBe('default'); // unchanged by setStatus
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
    expect(mockedStorage.saveAgentMessagesDelta).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5001);
    expect(mockedStorage.saveAgentMessagesDelta).toHaveBeenCalledTimes(1);
  });

  it('streaming-in-progress skips doSave (deferred to turn end)', () => {
    setStreaming(TAB, true);
    upsertMessage(TAB, textMsg('m1', 'mid-stream'));
    vi.advanceTimersByTime(5001);
    expect(mockedStorage.saveAgentMessagesDelta).not.toHaveBeenCalled();
  });

  it('removeTab flushes pending save synchronously', () => {
    upsertMessage(TAB, textMsg('m1', 'hi'));
    removeTab(TAB);
    expect(mockedStorage.saveAgentMessagesDelta).toHaveBeenCalledTimes(1);
  });
});

describe('agentTabStore — in-memory trim', () => {
  beforeEach(() => {
    setInMemoryMax(5);
    initTab(TAB, { sessionId: SESSION, provider: 'claude' });
  });

  it('trim runs at setStreaming(false), aligned to nearest user msg', () => {
    // Build u0,t0, u1,t1, u2,t2, u3,t3 — 8 msgs, user every other slot.
    for (let i = 0; i < 4; i++) {
      upsertMessage(TAB, userMsg(`u${i}`, `q${i}`));
      upsertMessage(TAB, textMsg(`t${i}`, `a${i}`));
    }
    // doSave throttle no longer trims — only setStreaming(false) does.
    vi.advanceTimersByTime(5001);
    expect(__getTabForTests(TAB)!.messages.length).toBe(8);

    setStreaming(TAB, true);
    setStreaming(TAB, false);
    // target idx = length - cap = 8 - 5 = 3 → messages[3] = t1 (not user),
    // so the loop walks forward to messages[4] = u2 and cuts there.
    // Kept tail = [u2, t2, u3, t3] = 4 msgs (slightly under cap — the
    // turn-alignment trade-off).
    const msgs = __getTabForTests(TAB)!.messages;
    expect(msgs.length).toBe(4);
    expect(msgs[0].id).toBe('u2');
  });

  it('streaming-in-progress does NOT trim (cap deferred to turn end)', () => {
    setStreaming(TAB, true);
    for (let i = 0; i < 8; i++) upsertMessage(TAB, textMsg(`m${i}`, `c${i}`));
    vi.advanceTimersByTime(5001);
    expect(__getTabForTests(TAB)!.messages.length).toBe(8);
  });
});

describe('agentTabStore — settings constraints', () => {
  it('setInMemoryMax floors at 1', () => {
    setInMemoryMax(0);
    expect(__getCapsForTests().inMemoryMax).toBe(1);
    setInMemoryMax(-50);
    expect(__getCapsForTests().inMemoryMax).toBe(1);
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

  it('opens a new turn on a startsTurn message (server-initiated auto-resume prose)', () => {
    // Background-task auto-resume prose has no `user` message; the startsTurn
    // flag must open its own block instead of gluing onto the prior turn.
    // See DECISIONS #69.
    const serverReply: AgentMsg = { ...textMsg('m2', 'sleep done'), startsTurn: true };
    const msgs: AgentMsg[] = [
      userMsg('u1', 'run sleep in background'),
      textMsg('m1', 'ok, backgrounding it'),
      serverReply,
    ];
    const turns = buildTurns(msgs);
    expect(turns.length).toBe(2);
    expect(turns[0].user?.id).toBe('u1');
    expect(turns[0].agent.map((m) => m.id)).toEqual(['m1']); // prose did NOT glue here
    expect(turns[1].user).toBeUndefined();
    expect(turns[1].agent.map((m) => m.id)).toEqual(['m2']);
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
    expect(__getTabForTests(TAB)!.initPhase).toBe(null);
    // starting + phase drives the refined spinner text
    setInitStatus(TAB, 'starting', null, 'checking-auth');
    expect(__getTabForTests(TAB)!.initStatus).toBe('starting');
    expect(__getTabForTests(TAB)!.initPhase).toBe('checking-auth');
    expect(__getTabForTests(TAB)!.initError).toBe(null);
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
