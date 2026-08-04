import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MEMORY_PROCESS_ROLE,
  MEMORY_REPORT_STATUS,
  MEMORY_WIRE_TYPE,
  type MemoryUsageReport,
} from '@shared/process-memory';
import {
  createProcessMemoryRegistry,
  createProcessMemoryRuntime,
  computeProcessMemorySummary,
  execMemorySourceId,
  getProcessMemorySourceStates,
} from './process-memory-manager';
import { MEM_SOURCE_STALE_AFTER_MS, MEMORY_AVAILABILITY } from '@shared/process-memory';

vi.mock('electron', () => ({ app: { getAppMetrics: vi.fn(() => []) } }));
vi.mock('./agent/remote', () => ({ requestAllAgentMemoryUsage: vi.fn() }));

const success = (memoryKiB: number): MemoryUsageReport => ({
  type: MEMORY_WIRE_TYPE.USAGE,
  status: MEMORY_REPORT_STATUS.OK,
  sampledAt: '2026-08-05T00:00:00.000Z',
  rows: [{ pid: 10, ppid: 1, memoryKiB, role: MEMORY_PROCESS_ROLE.EXEC }],
});

afterEach(() => vi.useRealTimers());

describe('process memory source registry', () => {
  it('registers as not-yet-sampled and timestamps successful reports on receive', () => {
    const records: any[] = [];
    const registry = createProcessMemoryRegistry({
      now: () => new Date('2026-08-05T01:02:03.000Z'),
      record: (record) => records.push(record),
    });
    registry.register({
      id: execMemorySourceId('tab-1'),
      kind: 'exec',
      connectionScopeKey: 'local',
      tabId: 'tab-1',
      provider: 'claude',
    });
    expect(registry.snapshot()[0].report).toBeUndefined();

    expect(registry.accept(execMemorySourceId('tab-1'), success(100))).toBe(true);
    expect(registry.snapshot()[0]).toMatchObject({
      lastSuccessReceivedAt: Date.parse('2026-08-05T01:02:03.000Z'),
      report: { rows: [{ memoryKiB: 100 }] },
    });
    expect(records[0]).toMatchObject({ accepted: true, receivedAt: '2026-08-05T01:02:03.000Z' });
  });

  it('records a failed attempt without replacing or refreshing the last success', () => {
    let now = new Date('2026-08-05T01:00:00.000Z');
    const registry = createProcessMemoryRegistry({ now: () => now });
    const id = execMemorySourceId('tab-1');
    registry.register({ id, kind: 'exec', connectionScopeKey: 'local', tabId: 'tab-1', provider: 'claude' });
    registry.accept(id, success(100));
    now = new Date('2026-08-05T02:00:00.000Z');
    registry.accept(id, {
      type: MEMORY_WIRE_TYPE.USAGE,
      status: MEMORY_REPORT_STATUS.ERROR,
      sampledAt: now.toISOString(),
      error: 'ps failed',
    });
    expect(registry.snapshot()[0]).toMatchObject({
      lastSuccessReceivedAt: Date.parse('2026-08-05T01:00:00.000Z'),
      report: { rows: [{ memoryKiB: 100 }] },
    });
  });

  it('rejects and records reports after intentional unregister', () => {
    const records: any[] = [];
    const registry = createProcessMemoryRegistry({ record: (record) => records.push(record) });
    const id = execMemorySourceId('tab-1');
    registry.register({ id, kind: 'exec', connectionScopeKey: 'local', tabId: 'tab-1', provider: 'claude' });
    registry.unregister(id);
    expect(registry.accept(id, success(100))).toBe(false);
    expect(registry.snapshot()).toEqual([]);
    expect(records[0]).toMatchObject({ accepted: false, reason: 'source is not registered' });
  });
});

describe('process memory acquisition runtime', () => {
  it('samples App once after warm-up and samples App plus agents every five minutes', async () => {
    vi.useFakeTimers();
    const requestAgents = vi.fn();
    const getAppMetrics = vi.fn(() => [{
      pid: 1,
      type: 'Browser' as const,
      creationTime: 0,
      cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 420, peakWorkingSetSize: 420 },
    }]);
    const runtime = createProcessMemoryRuntime({ getAppMetrics, requestAgents });
    runtime.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(getAppMetrics).toHaveBeenCalledTimes(1);
    expect(requestAgents).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(290_000);
    expect(getAppMetrics).toHaveBeenCalledTimes(2);
    expect(requestAgents).toHaveBeenCalledTimes(1);
    expect(getProcessMemorySourceStates().find((source) => source.source.id === 'app')).toMatchObject({
      report: { rows: [{ memoryKiB: 420, role: MEMORY_PROCESS_ROLE.APP_BROWSER }] },
    });
    runtime.stop();
  });

  it('records and publishes the exact same summary object', () => {
    vi.useFakeTimers();
    const recorded: any[] = [];
    const published: any[] = [];
    const runtime = createProcessMemoryRuntime({
      getAppMetrics: () => [],
      requestAgents: () => {},
      now: () => new Date('2026-08-05T00:00:00.000Z'),
      getConnectionScopeKeys: () => ['local'],
      recordSummary: (summary) => recorded.push(summary),
      publishSummary: (summary) => published.push(summary),
    });
    runtime.start();
    const summary = runtime.runSummary();
    expect(recorded[0]).toBe(summary);
    expect(published[0]).toBe(summary);
    expect(runtime.getLatestSummary()).toBe(summary);
    runtime.stop();
  });
});

describe('computeProcessMemorySummary', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');
  const receivedAt = now.getTime();
  const state = (
    source: any,
    rows: any[],
    ageMs = 0,
  ) => ({
    source,
    report: {
      type: MEMORY_WIRE_TYPE.USAGE,
      status: MEMORY_REPORT_STATUS.OK,
      sampledAt: '2000-01-01T00:00:00.000Z',
      rows,
    },
    lastSuccessReceivedAt: receivedAt - ageMs,
  });

  it('computes App, Runtime, Agents(N), and per-tab values from fresh sources', () => {
    const summary = computeProcessMemorySummary({
      now,
      connectionScopeKeys: ['local'],
      tabIds: ['tab-1'],
      sources: [
        state({ id: 'app', kind: 'app' }, [
          { pid: 1, memoryKiB: 100, role: MEMORY_PROCESS_ROLE.APP_BROWSER },
          { pid: 2, memoryKiB: 200, role: MEMORY_PROCESS_ROLE.APP_RENDERER },
        ]),
        state({ id: 'dispatcher:local', kind: 'dispatcher', connectionScopeKey: 'local' }, [
          { pid: 10, memoryKiB: 300, role: MEMORY_PROCESS_ROLE.DISPATCHER },
        ]),
        state({ id: 'exec:tab-1', kind: 'exec', connectionScopeKey: 'local', tabId: 'tab-1', provider: 'claude' }, [
          { pid: 20, memoryKiB: 400, role: MEMORY_PROCESS_ROLE.EXEC },
          { pid: 21, memoryKiB: 500, role: MEMORY_PROCESS_ROLE.PROVIDER },
          { pid: 22, memoryKiB: 600, role: MEMORY_PROCESS_ROLE.PROVIDER },
        ]),
      ],
    });
    expect(summary.app).toMatchObject({ availability: MEMORY_AVAILABILITY.AVAILABLE, memoryKiB: 300 });
    expect(summary.connections.local).toEqual({
      runtime: { availability: MEMORY_AVAILABILITY.AVAILABLE, memoryKiB: 700, excludedSources: 0 },
      agents: { availability: MEMORY_AVAILABILITY.AVAILABLE, memoryKiB: 1100, excludedSources: 0 },
      agentCount: 1,
    });
    expect(summary.tabs['tab-1']).toMatchObject({ memoryKiB: 1500 });
  });

  it('keeps a fresh partial subtotal while excluding stale sources', () => {
    const summary = computeProcessMemorySummary({
      now,
      connectionScopeKeys: ['local'],
      tabIds: ['fresh', 'stale'],
      sources: [
        state({ id: 'exec:fresh', kind: 'exec', connectionScopeKey: 'local', tabId: 'fresh', provider: 'claude' }, [
          { pid: 20, memoryKiB: 100, role: MEMORY_PROCESS_ROLE.EXEC },
          { pid: 21, memoryKiB: 200, role: MEMORY_PROCESS_ROLE.PROVIDER },
        ]),
        state({ id: 'exec:stale', kind: 'exec', connectionScopeKey: 'local', tabId: 'stale', provider: 'codex' }, [
          { pid: 30, memoryKiB: 900, role: MEMORY_PROCESS_ROLE.EXEC },
          { pid: 31, memoryKiB: 900, role: MEMORY_PROCESS_ROLE.PROVIDER },
        ], MEM_SOURCE_STALE_AFTER_MS + 1),
      ],
    });
    expect(summary.connections.local.runtime).toEqual({
      availability: MEMORY_AVAILABILITY.AVAILABLE,
      memoryKiB: 100,
      excludedSources: 1,
    });
    expect(summary.connections.local.agents).toEqual({
      availability: MEMORY_AVAILABILITY.AVAILABLE,
      memoryKiB: 200,
      excludedSources: 1,
    });
    expect(summary.connections.local.agentCount).toBe(1);
    expect(summary.tabs.stale).toEqual({
      availability: MEMORY_AVAILABILITY.UNAVAILABLE,
      excludedSources: 1,
    });
    expect(summary.excludedSourceCount).toBe(1);
  });

  it('distinguishes all-unavailable sources from a truly empty scope', () => {
    const summary = computeProcessMemorySummary({
      now,
      connectionScopeKeys: ['empty', 'waiting'],
      tabIds: ['empty-tab', 'waiting-tab'],
      sources: [{
        source: { id: 'exec:waiting-tab', kind: 'exec', connectionScopeKey: 'waiting', tabId: 'waiting-tab', provider: 'claude' },
      }],
    });
    expect(summary.connections.empty).toEqual({
      runtime: { availability: MEMORY_AVAILABILITY.AVAILABLE, memoryKiB: 0, excludedSources: 0 },
      agents: { availability: MEMORY_AVAILABILITY.AVAILABLE, memoryKiB: 0, excludedSources: 0 },
      agentCount: 0,
    });
    expect(summary.tabs['empty-tab']).toEqual({
      availability: MEMORY_AVAILABILITY.AVAILABLE,
      memoryKiB: 0,
      excludedSources: 0,
    });
    expect(summary.connections.waiting.runtime.availability).toBe(MEMORY_AVAILABILITY.UNAVAILABLE);
    expect(summary.tabs['waiting-tab'].availability).toBe(MEMORY_AVAILABILITY.UNAVAILABLE);
  });
});
