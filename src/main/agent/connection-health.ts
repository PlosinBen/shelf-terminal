import type { ConnectionHealth, ConnectionHealthState } from '@shared/types';

/**
 * Connection-health tracker — the client-side half of the agent-server
 * heartbeat (see .agent feature `skills-workflows` §5.9 / planned DECISION).
 *
 * The app sends a periodic heartbeat (`{type:'ping', seq}`) to each
 * agent-server; the server echoes `{type:'pong', seq}`. RTT is measured ENTIRELY
 * on the client clock (`ackTime − sentTime` for the same seq) — the two ends are
 * NOT time-synchronised, so we must never compare the client's send-time to the
 * server's receive-time. This tracker is pure (clock injected) so it unit-tests
 * without timers.
 *
 * Health states (icon carries the steady state; the renderer flashes a row tint
 * on any worsening transition):
 *   healthy  — acks current, RTT near baseline
 *   slow     — acks current but latest RTT spiked vs the connection's own baseline
 *   unstable — ≥1 beat missed (no ack for ≥ unstableAfterMs)
 *   dead     — no ack for ≥ deadAfterMs
 */

export interface HealthThresholds {
  /** Heartbeat send interval. */
  intervalMs: number;
  /** No ack for ≥ this ⇒ unstable (≈1 beat missed). */
  unstableAfterMs: number;
  /** No ack for ≥ this ⇒ dead. */
  deadAfterMs: number;
  /** latest RTT > baseline × this (and > slowFloorMs) ⇒ slow. */
  slowFactor: number;
  /** Absolute floor so a tiny baseline (e.g. 2ms local) doesn't flag slow on noise. */
  slowFloorMs: number;
  /** Rolling window size for the RTT baseline (median). */
  rttWindow: number;
  /** Min samples before slow detection is trusted (baseline too noisy below this). */
  minSamplesForSlow: number;
}

/** Defaults: 1m beat, ~3m dead (3 missed beats). See §5.9 time params. */
export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  intervalMs: 60_000,
  unstableAfterMs: 90_000, // 1.5× interval — one beat clearly missed
  deadAfterMs: 180_000, // 3× interval
  slowFactor: 4,
  slowFloorMs: 3_000,
  rttWindow: 10,
  minSamplesForSlow: 3,
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export class ConnectionHealthTracker {
  private sent = new Map<number, number>(); // seq → sentTime (client clock)
  private rtts: number[] = [];
  private lastAckTime: number;
  private lastRtt: number | undefined;

  constructor(
    startTime: number,
    private readonly th: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
  ) {
    // Treat session start as the last "good" point so we don't flash dead
    // before the first beat round-trips.
    this.lastAckTime = startTime;
  }

  /** Record an outgoing heartbeat. Prunes long-unacked entries (lost beats). */
  onSent(seq: number, t: number): void {
    this.sent.set(seq, t);
    const cutoff = t - this.th.deadAfterMs;
    for (const [s, sentAt] of this.sent) {
      if (sentAt < cutoff) this.sent.delete(s);
    }
  }

  /** Record an ack. Unknown/duplicate seq is ignored. */
  onAck(seq: number, t: number): void {
    const sentAt = this.sent.get(seq);
    if (sentAt == null) return;
    this.sent.delete(seq);
    // Any older still-unacked beats are now considered lost.
    for (const s of [...this.sent.keys()]) if (s < seq) this.sent.delete(s);

    const rtt = Math.max(0, t - sentAt);
    this.lastRtt = rtt;
    this.lastAckTime = t;
    this.rtts.push(rtt);
    if (this.rtts.length > this.th.rttWindow) this.rtts.shift();
  }

  /** Pure derivation of the current health at time `t`. */
  evaluate(t: number): ConnectionHealth {
    const sinceAck = t - this.lastAckTime;

    if (sinceAck >= this.th.deadAfterMs) {
      return { state: 'dead', lastAckAgoMs: sinceAck };
    }
    if (sinceAck >= this.th.unstableAfterMs) {
      return { state: 'unstable', lastAckAgoMs: sinceAck, ...(this.lastRtt != null ? { rttMs: this.lastRtt } : {}) };
    }
    // Acks are current → maybe slow (RTT spike relative to own baseline).
    if (this.lastRtt != null && this.rtts.length >= this.th.minSamplesForSlow) {
      const base = median(this.rtts);
      if (this.lastRtt > Math.max(base * this.th.slowFactor, this.th.slowFloorMs)) {
        return { state: 'slow', rttMs: this.lastRtt, lastAckAgoMs: sinceAck };
      }
    }
    const state: ConnectionHealthState = 'healthy';
    return { state, lastAckAgoMs: sinceAck, ...(this.lastRtt != null ? { rttMs: this.lastRtt } : {}) };
  }
}
