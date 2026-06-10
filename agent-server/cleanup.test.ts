import { describe, it, expect } from 'vitest';
import { compareVersions, planVersionSweep, planAppsSweep, type VersionEntry, type AppEntry } from './cleanup';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

describe('compareVersions', () => {
  it('orders by numeric segments', () => {
    expect(compareVersions('2.5.2', '2.5.1')).toBeGreaterThan(0);
    expect(compareVersions('2.5.2', '2.6.0')).toBeLessThan(0);
    expect(compareVersions('2.5.2', '2.5.2')).toBe(0);
    expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0);
  });
});

function v(name: string, deployedAgo: number | null, heartbeatAgo: number | null): VersionEntry {
  return {
    name,
    deployedMtime: deployedAgo == null ? null : NOW - deployedAgo,
    heartbeatMtime: heartbeatAgo == null ? null : NOW - heartbeatAgo,
  };
}

describe('planVersionSweep', () => {
  it('keeps current + previous (count floor) regardless of age', () => {
    const entries = [v('2.5.2', 10 * DAY, null), v('2.5.1', 10 * DAY, null), v('2.5.0', 10 * DAY, null)];
    // current = 2.5.2; floor keeps top 2 (2.5.2, 2.5.1); 2.5.0 is old + no lease → delete
    expect(planVersionSweep(entries, '2.5.2', NOW)).toEqual(['2.5.0']);
  });

  it('keeps a non-floor version whose heartbeat lease is fresh (m:n in-use)', () => {
    // app B is live on old 2.5.0 (fresh heartbeat) while app A runs 2.5.2
    const entries = [v('2.5.2', 1 * DAY, null), v('2.5.1', 10 * DAY, null), v('2.5.0', 10 * DAY, 1000)];
    expect(planVersionSweep(entries, '2.5.2', NOW)).toEqual([]); // nothing deleted: 2.5.0 lease fresh
  });

  it('reclaims a non-floor version once its lease is stale (> 1 day)', () => {
    const entries = [v('2.5.2', 1 * DAY, null), v('2.5.1', 1 * DAY, null), v('2.5.0', 10 * DAY, 2 * DAY)];
    expect(planVersionSweep(entries, '2.5.2', NOW)).toEqual(['2.5.0']);
  });

  it('never deletes a dir without .deployed (half-finished transfer)', () => {
    const entries = [v('2.5.2', 1 * DAY, null), v('2.5.1', 1 * DAY, null), v('2.5.0', null, null)];
    expect(planVersionSweep(entries, '2.5.2', NOW)).toEqual([]);
  });

  it('falls back to deployed mtime when there is no heartbeat', () => {
    const entries = [v('2.5.2', 1 * DAY, null), v('2.5.1', 1 * DAY, null), v('2.5.0', 2 * DAY, null)];
    expect(planVersionSweep(entries, '2.5.2', NOW)).toEqual(['2.5.0']);
  });
});

function a(id: string, heartbeatAgo: number | null): AppEntry {
  return { id, heartbeatMtime: heartbeatAgo == null ? null : NOW - heartbeatAgo };
}

describe('planAppsSweep', () => {
  it('keeps current + fresh-lease apps, deletes stale orphans', () => {
    const entries = [a('cur', 5 * DAY), a('live', 1000), a('orphan', 2 * DAY), a('never', null)];
    expect(planAppsSweep(entries, 'cur', NOW).sort()).toEqual(['never', 'orphan']);
  });

  it('with no current app, keeps only fresh-lease apps', () => {
    const entries = [a('live', 1000), a('orphan', 2 * DAY)];
    expect(planAppsSweep(entries, undefined, NOW)).toEqual(['orphan']);
  });
});
