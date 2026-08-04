import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessMemorySummary } from '@shared/process-memory';
import { bindProcessMemorySummary } from './process-memory-sync';
import { __getSnapshotForTests, __resetStoreForTests } from './store';

function makeSummary(label: string, connection: string): ProcessMemorySummary {
  return {
    summarizedAt: label,
    app: { availability: 'available', memoryKiB: 100, excludedSources: 0 },
    connections: {
      [connection]: {
        runtime: { availability: 'available', memoryKiB: 20, excludedSources: 0 },
        agents: { availability: 'available', memoryKiB: 30, excludedSources: 0 },
        agentCount: 1,
      },
    },
    tabs: { [`tab-${connection}`]: { availability: 'available', memoryKiB: 30, excludedSources: 0 } },
    excludedSourceCount: 0,
  };
}

beforeEach(() => {
  __resetStoreForTests();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('bindProcessMemorySummary', () => {
  it('subscribes before invoking the hydration getter', async () => {
    const calls: string[] = [];
    const hydrated = makeSummary('hydrated', 'local');
    (globalThis as any).window = {
      shelfApi: {
        agent: {
          onMemoryUsage: () => { calls.push('listen'); return vi.fn(); },
          getMemoryUsage: () => { calls.push('get'); return Promise.resolve(hydrated); },
        },
        app: { debugLog: vi.fn() },
      },
    };

    const off = bindProcessMemorySummary();
    await Promise.resolve();

    expect(calls).toEqual(['listen', 'get']);
    expect(__getSnapshotForTests().processMemorySummary).toBe(hydrated);
    off();
  });

  it('keeps a pushed snapshot when an older getter resolves afterward', async () => {
    let resolveHydration!: (summary: ProcessMemorySummary) => void;
    let onPush!: (summary: ProcessMemorySummary) => void;
    const older = makeSummary('older', 'local');
    const pushed = makeSummary('pushed', 'ssh:host:22:user');
    (globalThis as any).window = {
      shelfApi: {
        agent: {
          onMemoryUsage: (callback: typeof onPush) => { onPush = callback; return vi.fn(); },
          getMemoryUsage: () => new Promise<ProcessMemorySummary>((resolve) => { resolveHydration = resolve; }),
        },
        app: { debugLog: vi.fn() },
      },
    };

    const off = bindProcessMemorySummary();
    onPush(pushed);
    resolveHydration(older);
    await Promise.resolve();

    expect(__getSnapshotForTests().processMemorySummary).toBe(pushed);
    expect(__getSnapshotForTests().processMemorySummary?.connections).toEqual(pushed.connections);
    expect(__getSnapshotForTests().processMemorySummary?.connections).not.toHaveProperty('local');
    off();
  });
});
