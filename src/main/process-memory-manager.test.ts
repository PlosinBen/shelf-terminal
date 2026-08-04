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
  execMemorySourceId,
  getProcessMemorySourceStates,
} from './process-memory-manager';

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
});
