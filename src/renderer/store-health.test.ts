import { describe, it, expect } from 'vitest';
import { projectHealth, type ProjectRuntime } from './store';
import type { ConnectionHealth } from '@shared/types';

function proj(id: string, tabIds: string[]): ProjectRuntime {
  return {
    config: { id } as ProjectRuntime['config'],
    tabs: tabIds.map((tid) => ({ id: tid, label: tid, hasUnread: false, muted: false, type: 'agent' })),
    activeTabIndex: 0,
    splitTabId: null,
    folderInvalid: false,
  };
}

const h = (state: ConnectionHealth['state'], rttMs?: number): ConnectionHealth => ({ state, ...(rttMs != null ? { rttMs } : {}) });

describe('projectHealth (per-project aggregation)', () => {
  it('returns null when no tab is monitored', () => {
    expect(projectHealth(proj('p', ['a', 'b']), {})).toBeNull();
  });

  it('returns the only tab health when one is monitored', () => {
    expect(projectHealth(proj('p', ['a']), { a: h('slow', 120) })).toEqual(h('slow', 120));
  });

  it('returns the WORST among the project\'s tabs', () => {
    const health = { a: h('healthy', 10), b: h('dead'), c: h('slow', 200) };
    expect(projectHealth(proj('p', ['a', 'b', 'c']), health)?.state).toBe('dead');
  });

  it('ignores health entries for tabs not in this project', () => {
    const health = { a: h('healthy', 10), other: h('dead') };
    expect(projectHealth(proj('p', ['a']), health)?.state).toBe('healthy');
  });

  it('degradation order: unstable beats slow beats healthy', () => {
    expect(projectHealth(proj('p', ['a', 'b']), { a: h('healthy'), b: h('slow') })?.state).toBe('slow');
    expect(projectHealth(proj('p', ['a', 'b']), { a: h('slow'), b: h('unstable') })?.state).toBe('unstable');
  });
});
