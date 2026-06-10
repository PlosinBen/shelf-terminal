import { describe, it, expect } from 'vitest';
import { createRouterState, notePush, routeMessage, type RouterInput, type Lane } from './turn-router';

// Helper: feed a sequence of messages, return the lane each was routed to plus
// the actions, so tests can assert attribution against real spike sequences.
function run(state = createRouterState()) {
  const lanes: Array<{ lane: Lane; start?: boolean; close?: boolean }> = [];
  return {
    state,
    push() { notePush(state); return this; },
    feed(input: RouterInput) { const a = routeMessage(state, input); lanes.push(a); return this; },
    lanes,
    last() { return lanes[lanes.length - 1]; },
  };
}

const init = { type: 'system', systemSubtype: 'init' } as const;
const assistant = { type: 'assistant' } as const;
const fgResult = { type: 'result' } as const; // foreground result: no origin
const taskResult = { type: 'result', resultOrigin: 'task-notification' } as const;
const taskStarted = { type: 'system', systemSubtype: 'task_started' } as const;
const taskUpdated = { type: 'system', systemSubtype: 'task_updated' } as const;
const taskNote = { type: 'system', systemSubtype: 'task_notification' } as const;

describe('turn-router: single foreground turn', () => {
  it('init opens foreground, assistant routes there, result closes it', () => {
    const r = run().push()
      .feed(init).feed(assistant).feed(fgResult);
    expect(r.lanes[0]).toEqual({ lane: 'foreground', start: true });
    expect(r.lanes[1]).toEqual({ lane: 'foreground' });
    expect(r.lanes[2]).toEqual({ lane: 'foreground', close: true });
    expect(r.state.hasActiveForeground).toBe(false);
    expect(r.state.pendingPush).toBe(0);
  });
});

describe('turn-router: two serial foreground turns', () => {
  it('each init consumes one pending push; results close in order', () => {
    const r = run().push().push()
      .feed(init).feed(assistant).feed(fgResult)   // turn A
      .feed(init).feed(assistant).feed(fgResult);  // turn B
    expect(r.lanes.map((l) => l.lane)).toEqual([
      'foreground', 'foreground', 'foreground',
      'foreground', 'foreground', 'foreground',
    ]);
    expect(r.lanes[0].start).toBe(true);
    expect(r.lanes[3].start).toBe(true);
    expect(r.state.pendingPush).toBe(0);
    expect(r.state.hasActiveForeground).toBe(false);
  });
});

describe('turn-router: background task interleave (the core scenario)', () => {
  // Mirrors spike exp3 wire order exactly:
  //   A: init, assistant, assistant(tool), task_started, user(tool_result),
  //      assistant, result(foreground)
  //   B: init, assistant, result(foreground)
  //   auto-resume: task_updated, task_notification, init, assistant,
  //                result(origin=task-notification)
  it('B is attributed to foreground; auto-resume to server lane', () => {
    const r = run().push() // A pushed
      .feed(init)                                   // A start
      .feed(assistant)
      .feed({ type: 'assistant' })                  // tool_use assistant
      .feed(taskStarted)                            // → task lane (no auto-resume yet)
      .feed({ type: 'user' })                       // tool_result
      .feed(assistant)
      .feed(fgResult);                              // A close (foreground)

    expect(r.state.hasActiveForeground).toBe(false);
    expect(r.lanes[3]).toEqual({ lane: 'task' });   // task_started
    expect(r.state.autoResumeArmed).toBe(0);        // task_started does NOT arm

    r.push()                                        // B pushed during A's bg task
      .feed(init)                                   // B start (autoResumeArmed=0 → foreground)
      .feed(assistant)
      .feed(fgResult);                              // B close
    expect(r.lanes[7]).toEqual({ lane: 'foreground', start: true }); // B init
    expect(r.lanes[8]).toEqual({ lane: 'foreground' });              // B "4"
    expect(r.lanes[9]).toEqual({ lane: 'foreground', close: true });

    // Auto-resume after settle
    r.feed(taskUpdated)                             // task lane
      .feed(taskNote)                               // task lane + ARM
      .feed(init)                                   // → server (armed)
      .feed(assistant)                              // server
      .feed(taskResult);                            // server close
    expect(r.lanes[10]).toEqual({ lane: 'task' });
    expect(r.lanes[11]).toEqual({ lane: 'task' });  // task_notification
    expect(r.state.autoResumeArmed).toBe(0);        // consumed by init
    expect(r.lanes[12]).toEqual({ lane: 'server', start: true });
    expect(r.lanes[13]).toEqual({ lane: 'server' });
    expect(r.lanes[14]).toEqual({ lane: 'server', close: true });
    expect(r.state.hasActiveServer).toBe(false);
  });

  it('task_notification arms exactly one auto-resume per settle', () => {
    const r = run();
    r.feed(taskNote);
    expect(r.state.autoResumeArmed).toBe(1);
    r.feed(taskNote);
    expect(r.state.autoResumeArmed).toBe(2);
    r.feed(init); // consumes one
    expect(r.state.autoResumeArmed).toBe(1);
    expect(r.last()).toEqual({ lane: 'server', start: true });
  });
});

describe('turn-router: interrupt', () => {
  it('an interrupted turn still closes via its foreground result (no origin)', () => {
    // interrupt() yields a result with subtype=error_during_execution but NO
    // origin → still a foreground close. The provider maps the subtype to
    // stopped/idle; the router only cares about attribution.
    const r = run().push()
      .feed(init).feed(assistant).feed(fgResult);
    expect(r.last()).toEqual({ lane: 'foreground', close: true });
    expect(r.state.hasActiveForeground).toBe(false);
  });
});

describe('turn-router: defensive edges', () => {
  it('a result with no active turn is ignored, not mis-attributed', () => {
    const r = run().feed(fgResult);
    expect(r.last()).toEqual({ lane: 'ignore' });
  });

  it('a task-notification result with no active server turn is ignored', () => {
    const r = run().feed(taskResult);
    expect(r.last()).toEqual({ lane: 'ignore' });
  });

  it('content before any init is ignored (no active lane)', () => {
    const r = run().feed(assistant);
    expect(r.last()).toEqual({ lane: 'ignore' });
  });

  it('a stray init with no pending push still opens foreground without underflow', () => {
    const r = run().feed(init);
    expect(r.last()).toEqual({ lane: 'foreground', start: true });
    expect(r.state.pendingPush).toBe(0);
  });
});
