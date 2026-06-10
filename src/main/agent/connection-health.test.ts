import { describe, it, expect } from 'vitest';
import { ConnectionHealthTracker, DEFAULT_HEALTH_THRESHOLDS, type HealthThresholds } from './connection-health';

// Fast thresholds for readable tests (same ratios as the defaults).
const TH: HealthThresholds = {
  intervalMs: 100,
  unstableAfterMs: 150,
  deadAfterMs: 300,
  slowFactor: 4,
  slowFloorMs: 30,
  rttWindow: 10,
  minSamplesForSlow: 3,
};

describe('ConnectionHealthTracker', () => {
  it('starts healthy and stays healthy with prompt acks', () => {
    const t = new ConnectionHealthTracker(0, TH);
    let now = 0;
    for (let seq = 0; seq < 5; seq++) {
      t.onSent(seq, now);
      now += 10; // 10ms RTT
      t.onAck(seq, now);
      now += 90; // next interval
    }
    expect(t.evaluate(now).state).toBe('healthy');
    expect(t.evaluate(now).rttMs).toBe(10);
  });

  it('reports unstable after one missed beat, dead after deadAfterMs', () => {
    const t = new ConnectionHealthTracker(0, TH);
    t.onSent(0, 0);
    t.onAck(0, 10); // lastAck = 10
    expect(t.evaluate(100).state).toBe('healthy'); // within unstable window
    expect(t.evaluate(10 + 150).state).toBe('unstable'); // sinceAck = 150
    expect(t.evaluate(10 + 300).state).toBe('dead'); // sinceAck = 300
  });

  it('detects slow when latest RTT spikes vs baseline', () => {
    const t = new ConnectionHealthTracker(0, TH);
    let now = 0;
    // Establish a ~10ms baseline (≥ minSamplesForSlow samples).
    for (let seq = 0; seq < 4; seq++) {
      t.onSent(seq, now);
      now += 10;
      t.onAck(seq, now);
      now += 90;
    }
    // Next beat takes 200ms (>> 10ms*4 and > slowFloor) → slow.
    t.onSent(99, now);
    now += 200;
    t.onAck(99, now);
    expect(t.evaluate(now).state).toBe('slow');
    expect(t.evaluate(now).rttMs).toBe(200);
  });

  it('does NOT flag slow on a tiny baseline within the floor', () => {
    const t = new ConnectionHealthTracker(0, TH);
    let now = 0;
    for (let seq = 0; seq < 4; seq++) {
      t.onSent(seq, now);
      now += 1; // 1ms baseline (local-ish)
      t.onAck(seq, now);
      now += 99;
    }
    // 20ms RTT: > 1ms*4 but < slowFloor(30) → still healthy.
    t.onSent(99, now);
    now += 20;
    t.onAck(99, now);
    expect(t.evaluate(now).state).toBe('healthy');
  });

  it('recovers: dead → ack → healthy', () => {
    const t = new ConnectionHealthTracker(0, TH);
    t.onSent(0, 0);
    t.onAck(0, 5);
    expect(t.evaluate(400).state).toBe('dead');
    // A fresh beat round-trips.
    t.onSent(1, 400);
    t.onAck(1, 410);
    expect(t.evaluate(420).state).toBe('healthy');
  });

  it('ignores acks for unknown/duplicate seq', () => {
    const t = new ConnectionHealthTracker(0, TH);
    t.onSent(0, 0);
    t.onAck(0, 10);
    t.onAck(0, 20); // duplicate — must not move lastAck/RTT
    t.onAck(999, 30); // never sent
    expect(t.evaluate(30).rttMs).toBe(10);
    expect(t.evaluate(30).lastAckAgoMs).toBe(20); // 30 - 10
  });

  it('default thresholds match the §5.9 spec (1m / 1.5m / 3m)', () => {
    expect(DEFAULT_HEALTH_THRESHOLDS.intervalMs).toBe(60_000);
    expect(DEFAULT_HEALTH_THRESHOLDS.deadAfterMs).toBe(180_000);
  });
});
