import { describe, it, expect, vi, afterEach } from 'vitest';
import type { OutgoingMessage } from '../types';

/**
 * Integration regression for the detached-loop M1 fix (background-tasks.md).
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

// Mock the SDK before importing the provider (value import of `query`).
const sdkQueryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => sdkQueryMock(...args),
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
// The SDK auto-resume turn after the task settles — its result carries origin.kind.
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

  it('surfaces the auto-resume prose as a server-initiated turn (M3: turn_started + reply + idle, fresh turnId)', async () => {
    // Regression for the M3 gap: when a backgrounded task finishes the SDK
    // auto-resumes the agent to write a real reply. It used to be dropped on
    // the dead foreground turnId (`if (foregroundDone) continue`). Now it must
    // be re-emitted as a server-initiated turn. See background-tasks.md M3.
    const { it, release } = controllableQuery(
      [INIT, FG_REPLY, TASK_STARTED, FG_RESULT],
      [TASK_DONE, RESUME_REPLY, RESUME_RESULT],
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
});
