import { describe, it, expect, vi, afterEach } from 'vitest';
import type { OutgoingMessage } from '../types';

/**
 * Integration regression for the detached-loop M1 fix (background-tasks#2).
 * The bug: when the model backgrounds a task, the SDK keeps its single-prompt
 * generator alive past the foreground `result` (to drain the task + auto-resume
 * the agent), and claude's `query()` only resolved at generator-end — blocking
 * the sendChain (next user send showed an infinite spinner). And the post-result
 * background content carried the now-dead turnId → dropped as "unknown turn".
 *
 * These tests mock the SDK with a *controllable* generator that suspends right
 * after the foreground `result`, so we can assert query() has ALREADY resolved
 * while the background is still pending — the core World-A fix.
 */

// Mock the SDK before importing the provider (value import of `query` + the
// in-process bridge-tool builders `tool` / `createSdkMcpServer`).
const sdkQueryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => sdkQueryMock(...args),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (opts: { name: string }) => ({ type: 'sdk', name: opts.name, instance: {} }),
}));

import { createClaudeBackend } from './index';

/** Build a fake SDK Query that yields `before`, suspends on an external gate,
 *  then yields `after` and ends. Returns the iterator + a `release` trigger. */
function controllableQuery(before: any[], after: any[]) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  async function* gen() {
    for (const m of before) yield m;
    await gate;
    for (const m of after) yield m;
  }
  const it: any = gen();
  it.supportedModels = async () => [];
  it.supportedCommands = async () => [];
  it.accountInfo = async () => ({ tokenSource: 'oauth' });
  it.interrupt = async () => {};
  return { it, release };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

const INIT = { type: 'system', subtype: 'init', session_id: 's1' };
const FG_REPLY = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Started in background' }] } };
const TASK_STARTED = { type: 'system', subtype: 'task_started', task_id: 't1', description: 'Sleep 30', task_type: 'local_bash', tool_use_id: 'toolu_x' };
const FG_RESULT = { type: 'result', subtype: 'success', session_id: 's1' };
const TASK_DONE = { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done (exit 0)', output_file: '/tmp/t1.output' };
// The SDK auto-resume turn after the task settles. Real wire order (Phase 0
// spike): task_notification → init → assistant → result(origin task-notification).
// The init is what opens the server turn (armed by the preceding notification);
// the result's origin closes it. See turn-router.ts.
const RESUME_INIT = { type: 'system', subtype: 'init', session_id: 's1' };
const RESUME_REPLY = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'The sleep finished — output: done' }] } };
const RESUME_RESULT = { type: 'result', subtype: 'success', origin: { kind: 'task-notification' }, session_id: 's1' };

describe('claude detached-loop background tasks', () => {
  let disposer: (() => void) | null = null;
  afterEach(() => {
    // Module-scoped task maps live in the backend module — dispose clears them
    // so tests don't pollute each other.
    disposer?.();
    disposer = null;
    sdkQueryMock.mockReset();
  });

  it('resolves query() at the foreground result while the background is still pending (sendChain unblock)', async () => {
    const { it, release } = controllableQuery(
      [INIT, FG_REPLY, TASK_STARTED, FG_RESULT],
      [TASK_DONE, RESUME_RESULT],
    );
    sdkQueryMock.mockImplementation(() => it);

    const sent: OutgoingMessage[] = [];
    const backend = createClaudeBackend();
    disposer = () => backend.dispose();

    // query() MUST resolve even though the generator is suspended at the gate
    // (background not drained yet). If the old code were in place this would
    // hang until release() + generator-end and the test would time out.
    await backend.query({ prompt: 'go', cwd: '/tmp' } as any, (m) => sent.push(m));

    // Foreground idle emitted exactly once.
    expect(sent.filter((m) => m.type === 'status' && (m as any).state === 'idle')).toHaveLength(1);

    // A snapshot of the still-running background task was emitted at foreground end.
    const snap = sent.find((m) => m.type === 'task_event' && (m as any).kind === 'snapshot') as any;
    expect(snap?.tasks).toEqual([{ id: 't1', type: 'shell', label: 'Sleep 30', status: 'running', done: false }]);

    // No terminal task_event yet — the background hasn't been drained.
    expect(sent.some((m) => m.type === 'task_event' && (m as any).kind === 'done')).toBe(false);

    // Drain the background.
    release();
    await flush();

    // Now the completion task_event lands (turnId-less; the orchestrator wrap
    // that omits turnId is covered separately in orchestrator.test.ts).
    const done = sent.find((m) => m.type === 'task_event' && (m as any).kind === 'done') as any;
    expect(done?.task).toMatchObject({ id: 't1', status: 'completed', done: true, summary: 'done (exit 0)' });

    // The SDK's auto-resume reply + its result are suppressed (no second idle,
    // no stray reply leaking on the dead turn).
    expect(sent.filter((m) => m.type === 'status' && (m as any).state === 'idle')).toHaveLength(1);
  });

  it('emits task_started LIVE mid-turn (panel updates as tasks start, not batched at close)', async () => {
    // UX fix: each task surfaces as its own live 'started' task_event the moment
    // it arrives — NOT held and dumped only in the close snapshot. Safe because a
    // sync Bash never emits task_started (scripts/spike-sync-vs-bg.ts). See #75.
    const started = (n: number) => ({
      type: 'system', subtype: 'task_started', task_id: `bg${n}`,
      description: `cmd ${n}`, task_type: 'local_bash', tool_use_id: `toolu_${n}`,
    });
    const { it } = controllableQuery([INIT, FG_REPLY, started(1), started(2), FG_RESULT], []);
    sdkQueryMock.mockImplementation(() => it);

    const sent: OutgoingMessage[] = [];
    const backend = createClaudeBackend();
    disposer = () => backend.dispose();

    await backend.query({ prompt: 'go', cwd: '/tmp' } as any, (m) => sent.push(m));

    const live = (id: string) => sent.filter((m) => m.type === 'task_event' && (m as any).kind === 'started' && (m as any).task?.id === id);
    expect(live('bg1')).toHaveLength(1); // emitted individually, not only via snapshot
    expect(live('bg2')).toHaveLength(1);
  });

  it('keeps N background tasks distinct — 5 task_started in one turn → snapshot of 5 (no collapse)', async () => {
    // Repro for "5 launched, panel shows 1". Real SDK (spike-bg-notify, 5×
    // run_in_background) emits 5 task_started with 5 DISTINCT task_ids, one per
    // tool_use_id — no reuse. So if a card is lost it must be in our path. This
    // pins the provider: 5 mid-turn task_started must be accumulated and snapshot
    // out as 5 distinct tasks (the renderer then upserts 5 cards by id).
    const started = (n: number) => ({
      type: 'system', subtype: 'task_started', task_id: `bg${n}`,
      description: `sleep ${n}`, task_type: 'local_bash', tool_use_id: `toolu_${n}`,
    });
    const { it, release } = controllableQuery(
      [INIT, FG_REPLY, started(1), started(2), started(3), started(4), started(5), FG_RESULT],
      [],
    );
    sdkQueryMock.mockImplementation(() => it);

    const sent: OutgoingMessage[] = [];
    const backend = createClaudeBackend();
    disposer = () => backend.dispose();

    await backend.query({ prompt: 'go', cwd: '/tmp' } as any, (m) => sent.push(m));
    release();
    await flush();

    const snap = sent.find((m) => m.type === 'task_event' && (m as any).kind === 'snapshot') as any;
    expect(snap).toBeTruthy();
    expect(snap.tasks.map((t: any) => t.id)).toEqual(['bg1', 'bg2', 'bg3', 'bg4', 'bg5']);
    expect(new Set(snap.tasks.map((t: any) => t.id)).size).toBe(5); // distinct, not collapsed
  });

  it('a background task that finishes BEFORE the foreground result is still surfaced (not dropped)', async () => {
    // The "5 launched, 1 shown" root cause: mid-turn task_* are accumulated (not
    // emitted individually), and the turn-close snapshot only carries STILL-RUNNING
    // tasks. So a backgrounded task that completes before the foreground result is
    // marked done in the map → excluded from the snapshot → never reaches the
    // renderer at all. Here bg1 completes mid-turn, bg2 stays running; BOTH must
    // surface (bg1 as completed, bg2 as running).
    const started = (n: number) => ({
      type: 'system', subtype: 'task_started', task_id: `bg${n}`,
      description: `cmd ${n}`, task_type: 'local_bash', tool_use_id: `toolu_${n}`,
    });
    const bg1Done = { type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed', summary: 'bg1 done', output_file: '/tmp/bg1' };
    const { it, release } = controllableQuery(
      [INIT, FG_REPLY, started(1), started(2), bg1Done, FG_RESULT],
      [],
    );
    sdkQueryMock.mockImplementation(() => it);

    const sent: OutgoingMessage[] = [];
    const backend = createClaudeBackend();
    disposer = () => backend.dispose();

    await backend.query({ prompt: 'go', cwd: '/tmp' } as any, (m) => sent.push(m));
    release();
    await flush();

    // Reconstruct what the renderer would hold after applying every task_event
    // (mirrors applyTaskEvent's by-id upsert over started/done/snapshot).
    const seen = new Map<string, any>();
    for (const m of sent) {
      if (m.type !== 'task_event') continue;
      const ev = m as any;
      for (const t of ev.kind === 'snapshot' ? (ev.tasks ?? []) : (ev.task ? [ev.task] : [])) seen.set(t.id, t);
    }
    expect([...seen.keys()].sort()).toEqual(['bg1', 'bg2']); // bg1 must NOT be dropped
    expect(seen.get('bg1')).toMatchObject({ id: 'bg1', status: 'completed', done: true });
    expect(seen.get('bg2')).toMatchObject({ id: 'bg2', status: 'running', done: false });
  });

  it('surfaces the auto-resume prose as a server-initiated turn (M3: turn_started + reply + idle, fresh turnId)', async () => {
    // Regression for the M3 gap: when a backgrounded task finishes the SDK
    // auto-resumes the agent to write a real reply. It used to be dropped on
    // the dead foreground turnId (`if (foregroundDone) continue`). Now it must
    // be re-emitted as a server-initiated turn. See background-tasks#2.
    const { it, release } = controllableQuery(
      [INIT, FG_REPLY, TASK_STARTED, FG_RESULT],
      [TASK_DONE, RESUME_INIT, RESUME_REPLY, RESUME_RESULT],
    );
    sdkQueryMock.mockImplementation(() => it);

    const sent: OutgoingMessage[] = [];
    const backend = createClaudeBackend();
    disposer = () => backend.dispose();

    await backend.query({ prompt: 'go', cwd: '/tmp' } as any, (m) => sent.push(m));
    release();
    await flush();

    // A server turn was opened with a fresh turnId (distinct from foreground).
    const started = sent.find((m) => m.type === 'turn_started') as any;
    expect(started?.turnId).toMatch(/^t-/);

    // The auto-resume drives busy state: a streaming status tagged with the
    // server turnId is emitted on open (main forwards it only when no foreground
    // turn is in flight, so the spinner reflects the agent writing). See #76.
    const serverStreaming = sent.find((m) => m.type === 'status' && (m as any).state === 'streaming'
      && (m as any).turnId === started.turnId);
    expect(serverStreaming).toBeTruthy();

    // The prose is re-emitted as a normal reply tagged with that turnId and
    // flagged startsTurn so the renderer opens a new turn block for it.
    const reply = sent.find((m) => m.type === 'message' && (m as any).msgType === 'reply'
      && (m as any).turnId === started.turnId) as any;
    expect(reply?.content).toContain('sleep finished');
    expect(reply?.startsTurn).toBe(true);

    // The server turn is closed with its OWN idle (carries the server turnId),
    // separate from the single foreground idle (which has no turnId here).
    const serverIdle = sent.find((m) => m.type === 'status' && (m as any).state === 'idle'
      && (m as any).turnId === started.turnId);
    expect(serverIdle).toBeTruthy();
    expect(sent.filter((m) => m.type === 'status' && (m as any).state === 'idle'
      && !(m as any).turnId)).toHaveLength(1); // foreground idle untouched
  });

  it('a turn with no backgrounded task emits no task_event and resolves normally', async () => {
    const { it, release } = controllableQuery([INIT, FG_REPLY, FG_RESULT], []);
    sdkQueryMock.mockImplementation(() => it);

    const sent: OutgoingMessage[] = [];
    const backend = createClaudeBackend();
    disposer = () => backend.dispose();

    await backend.query({ prompt: 'go', cwd: '/tmp' } as any, (m) => sent.push(m));
    release();
    await flush();

    expect(sent.some((m) => m.type === 'task_event')).toBe(false);
    expect(sent.filter((m) => m.type === 'status' && (m as any).state === 'idle')).toHaveLength(1);
  });

  it('stop() force-ends the active turn even when interrupt() is a no-op (ESC escape guarantee)', async () => {
    // The turn streams INIT + a reply, then the SDK generator suspends with NO
    // result (mimics a wedged turn). query() would hang forever. ESC → stop()
    // must unstick the UI + resolve query() on its own — interrupt() here is a
    // no-op (mock), proving stop() does not depend on it.
    const { it } = controllableQuery([INIT, FG_REPLY], []);
    sdkQueryMock.mockImplementation(() => it);

    const sent: OutgoingMessage[] = [];
    const backend = createClaudeBackend();
    disposer = () => backend.dispose();

    // Start the turn but DON'T await — it would hang (no result arrives).
    const turn = backend.query({ prompt: 'go', cwd: '/tmp' } as any, (m) => sent.push(m));
    await flush(); // consumer processes INIT + reply; turn is mid-stream
    expect(sent.some((m) => m.type === 'status' && (m as any).state === 'idle')).toBe(false);

    await backend.stop();

    // query() resolved (sendChain unblocks) and a foreground idle was emitted
    // (renderer spinner clears) — the highest-priority ESC guarantee.
    await expect(turn).resolves.toBeUndefined();
    expect(sent.filter((m) => m.type === 'status' && (m as any).state === 'idle')).toHaveLength(1);
  });

  it('stopTask forwards the taskId to the live session query (provider→SDK wiring)', async () => {
    // The SDK's run_in_background is nondeterministic about whether it emits a
    // task_started (so a real backgrounded task can't be reliably surfaced in a
    // smoke), so verify the wiring we own deterministically: stopTask reaches
    // the persistent query's SDK stopTask with the right id.
    const { it } = controllableQuery([INIT, FG_REPLY, FG_RESULT], []);
    const stopTaskMock = vi.fn(async () => {});
    it.stopTask = stopTaskMock;
    sdkQueryMock.mockImplementation(() => it);

    const backend = createClaudeBackend();
    disposer = () => backend.dispose();
    await backend.query({ prompt: 'go', cwd: '/tmp' } as any, () => {}); // opens the persistent session
    await backend.stopTask!('task-123');
    expect(stopTaskMock).toHaveBeenCalledWith('task-123');
  });

  it('stopTask is a no-op (no throw) when there is no live session', async () => {
    const backend = createClaudeBackend();
    disposer = () => backend.dispose();
    await expect(backend.stopTask!('whatever')).resolves.toBeUndefined();
  });

  it('readTaskOutput returns a friendly note (not a throw) for a task with no output file', async () => {
    // Regression: subagent / monitor / workflow tasks (and tasks that settled via
    // task_updated without a terminal task_notification) never record an
    // output_file. Clicking such a completed task used to throw "No output file
    // recorded for task …", surfacing as a raw "invoke remote method" error in
    // the panel. It must resolve to a calm message instead.
    const backend = createClaudeBackend();
    disposer = () => backend.dispose();

    await expect(backend.readTaskOutput!('never-recorded')).resolves.toBe('(no output recorded for this task)');
  });
});
