import { describe, it, expect } from 'vitest';
import { createRouterState, notePush, routeMessage, type RouterInput, type Lane } from './turn-router';

// Feed a sequence of messages, capture the lane/action each routed to so tests
// can assert attribution against real spike sequences.
function run(state = createRouterState()) {
  const lanes: Array<{ lane: Lane; start?: boolean; close?: boolean }> = [];
  return {
    state,
    push() { notePush(state); return this; },
    feed(input: RouterInput) { lanes.push(routeMessage(state, input)); return this; },
    lanes,
    last() { return lanes[lanes.length - 1]; },
  };
}

const init = { type: 'system', systemSubtype: 'init' } as const;
const assistant = { type: 'assistant' } as const;
const result = { type: 'result' } as const; // a result closes whatever turn is active
const taskStarted = { type: 'system', systemSubtype: 'task_started' } as const;
const taskUpdated = { type: 'system', systemSubtype: 'task_updated' } as const;
const taskNote = { type: 'system', systemSubtype: 'task_notification' } as const;

describe('turn-router: single foreground turn', () => {
  it('init opens foreground, assistant routes there, result closes it', () => {
    const r = run().push().feed(init).feed(assistant).feed(result);
    expect(r.lanes[0]).toEqual({ lane: 'foreground', start: true });
    expect(r.lanes[1]).toEqual({ lane: 'foreground' });
    expect(r.lanes[2]).toEqual({ lane: 'foreground', close: true });
    expect(r.state.active).toBeNull();
    expect(r.state.pendingPush).toBe(0);
  });
});

describe('turn-router: two serial foreground turns', () => {
  it('each init consumes one pending push; results close in order', () => {
    const r = run().push().push()
      .feed(init).feed(assistant).feed(result)
      .feed(init).feed(assistant).feed(result);
    expect(r.lanes.map((l) => l.lane)).toEqual(Array(6).fill('foreground'));
    expect(r.lanes[0].start).toBe(true);
    expect(r.lanes[3].start).toBe(true);
    expect(r.state.pendingPush).toBe(0);
    expect(r.state.active).toBeNull();
  });
});

describe('turn-router: background task interleave', () => {
  // Mirrors spike exp3: A backgrounds a task and replies; B is pushed while the
  // task runs; the task settles and the SDK auto-resumes a server turn.
  it('B is attributed to foreground; auto-resume to server lane', () => {
    const r = run().push()
      .feed(init).feed(assistant).feed(assistant) // A: init + reply + tool_use
      .feed(taskStarted)                          // → task lane
      .feed({ type: 'user' }).feed(assistant).feed(result); // tool_result, reply, A close
    expect(r.lanes[3]).toEqual({ lane: 'task' });
    expect(r.state.active).toBeNull();

    r.push().feed(init).feed(assistant).feed(result); // B pushed during A's bg task
    expect(r.lanes[7]).toEqual({ lane: 'foreground', start: true });
    expect(r.lanes[8]).toEqual({ lane: 'foreground' });
    expect(r.lanes[9]).toEqual({ lane: 'foreground', close: true });

    r.feed(taskUpdated).feed(taskNote)  // task lane
      .feed(init).feed(assistant).feed(result); // auto-resume: no pending push → server
    expect(r.lanes[10]).toEqual({ lane: 'task' });
    expect(r.lanes[11]).toEqual({ lane: 'task' });
    expect(r.lanes[12]).toEqual({ lane: 'server', start: true });
    expect(r.lanes[13]).toEqual({ lane: 'server' });
    expect(r.lanes[14]).toEqual({ lane: 'server', close: true });
    expect(r.state.active).toBeNull();
  });
});

describe('turn-router: task_notification WITHOUT a following auto-resume (the stuck-bug repro)', () => {
  // A backgrounded task settles but the model stays silent → task_notification
  // with NO following init. The NEXT genuine foreground turn must still open +
  // close (the counter-based design drifted here and hung the turn).
  it('the next foreground turn still opens + closes (no hang)', () => {
    const r = run().push()
      .feed(init).feed(assistant).feed(taskStarted).feed(result); // turn A + bg task
    r.feed(taskUpdated).feed(taskNote);                            // settles, no auto-resume
    r.push().feed(init).feed(assistant).feed(result);             // turn B (user)
    expect(r.lanes[6]).toEqual({ lane: 'foreground', start: true });
    expect(r.lanes[8]).toEqual({ lane: 'foreground', close: true });
    expect(r.state.active).toBeNull();
    expect(r.state.pendingPush).toBe(0);
  });

  it('task_* messages never change turn attribution', () => {
    const r = run();
    r.feed(taskNote).feed(taskUpdated).feed(taskStarted);
    expect(r.lanes.every((l) => l.lane === 'task')).toBe(true);
    expect(r.state).toEqual({ pendingPush: 0, active: null });
  });
});

describe('turn-router: interrupt', () => {
  it('an interrupted turn still closes via its (origin-less) result', () => {
    const r = run().push().feed(init).feed(assistant).feed(result);
    expect(r.last()).toEqual({ lane: 'foreground', close: true });
    expect(r.state.active).toBeNull();
  });
});

describe('turn-router: defensive edges', () => {
  it('a result with no active turn is ignored', () => {
    expect(run().feed(result).last()).toEqual({ lane: 'ignore' });
  });

  it('content before any init is ignored (no active lane)', () => {
    expect(run().feed(assistant).last()).toEqual({ lane: 'ignore' });
  });

  it('an init with no pending push opens a server turn (assumed auto-resume), no underflow', () => {
    const r = run().feed(init);
    expect(r.last()).toEqual({ lane: 'server', start: true });
    expect(r.state.pendingPush).toBe(0);
    expect(r.state.active).toBe('server');
  });
});
