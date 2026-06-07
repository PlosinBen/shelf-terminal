import { describe, it, expect } from 'vitest';
import { reduceFlush } from './queue-flush';

describe('reduceFlush', () => {
  it('streaming never flushes and re-arms', () => {
    expect(reduceFlush(false, { isStreaming: true, queueLength: 5 })).toEqual({ armed: true, flush: false });
    expect(reduceFlush(true, { isStreaming: true, queueLength: 0 })).toEqual({ armed: true, flush: false });
  });

  it('idle + armed + non-empty flushes one and disarms', () => {
    expect(reduceFlush(true, { isStreaming: false, queueLength: 2 })).toEqual({ armed: false, flush: true });
  });

  it('idle + DISARMED + non-empty holds (burst guard)', () => {
    // This is the window right after a flush, before the streaming status
    // round-trips: the queue is non-empty but we must NOT drain it.
    expect(reduceFlush(false, { isStreaming: false, queueLength: 3 })).toEqual({ armed: false, flush: false });
  });

  it('idle + armed + empty holds (nothing to do)', () => {
    expect(reduceFlush(true, { isStreaming: false, queueLength: 0 })).toEqual({ armed: true, flush: false });
  });
});

/**
 * Drive reduceFlush exactly as the component effect does — armed in a "ref",
 * dequeue on flush — to prove end-to-end that N queued messages flush ONE per
 * streaming→idle cycle, never in a burst.
 */
function makeDriver(initialQueue: number) {
  let armed = true;
  let queue = initialQueue;
  let isStreaming = false;
  const flushes: number[] = []; // queue length observed at each flush

  // Re-run the reducer on the current observation (mirrors the effect firing).
  function tick() {
    const d = reduceFlush(armed, { isStreaming, queueLength: queue });
    armed = d.armed;
    if (d.flush) {
      queue -= 1; // dequeue one
      flushes.push(queue + 1);
    }
  }
  return {
    enqueue() { queue += 1; tick(); },
    setStreaming(v: boolean) { isStreaming = v; tick(); },
    get queue() { return queue; },
    get flushCount() { return flushes.length; },
  };
}

describe('reduceFlush — one-at-a-time drain (burst regression)', () => {
  it('drains 3 messages one per streaming→idle cycle, not all at once', () => {
    const d = makeDriver(0);

    // T1 arrives while idle → flushes immediately, disarms.
    d.enqueue();
    expect(d.flushCount).toBe(1);
    expect(d.queue).toBe(0);

    // T2 and T3 enqueue while T1's streaming status hasn't arrived yet
    // (isStreaming still false, armed false) → MUST NOT flush. This is the
    // exact window the old code drained as a burst.
    d.enqueue();
    d.enqueue();
    expect(d.flushCount).toBe(1); // still just T1
    expect(d.queue).toBe(2);      // T2, T3 held

    // T1 streaming begins → re-arm (no flush while streaming).
    d.setStreaming(true);
    expect(d.flushCount).toBe(1);

    // T1 idles → exactly ONE (T2) flushes; T3 stays.
    d.setStreaming(false);
    expect(d.flushCount).toBe(2);
    expect(d.queue).toBe(1);

    // T2 streaming → idle → T3 flushes. Queue drains fully, one at a time.
    d.setStreaming(true);
    d.setStreaming(false);
    expect(d.flushCount).toBe(3);
    expect(d.queue).toBe(0);
  });

  it('never flushes more than once per idle transition even with a deep queue', () => {
    const d = makeDriver(0);
    d.enqueue(); // T1 flushes
    for (let i = 0; i < 9; i++) d.enqueue(); // 9 more queued during the disarmed window
    expect(d.flushCount).toBe(1);
    expect(d.queue).toBe(9);

    // Each streaming→idle cycle releases exactly one.
    for (let i = 0; i < 9; i++) {
      d.setStreaming(true);
      d.setStreaming(false);
    }
    expect(d.flushCount).toBe(10);
    expect(d.queue).toBe(0);
  });
});
