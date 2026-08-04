import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_PROCESS_ROLE, MEMORY_REPORT_STATUS, MEMORY_WIRE_TYPE } from '@shared/process-memory';
import { sampleMemoryUsage, scheduleInitialMemoryReport } from './memory-report';

afterEach(() => vi.useRealTimers());

describe('sampleMemoryUsage', () => {
  it('reports dispatcher self without child execs', async () => {
    await expect(sampleMemoryUsage({
      kind: 'dispatcher',
      pid: 10,
      now: () => new Date('2026-08-05T00:00:00.000Z'),
      snapshot: async () => [
        { pid: 10, ppid: 1, memoryKiB: 100 },
        { pid: 11, ppid: 10, memoryKiB: 200 },
      ],
    })).resolves.toEqual({
      type: MEMORY_WIRE_TYPE.USAGE,
      status: MEMORY_REPORT_STATUS.OK,
      sampledAt: '2026-08-05T00:00:00.000Z',
      rows: [{ pid: 10, ppid: 1, memoryKiB: 100, role: MEMORY_PROCESS_ROLE.DISPATCHER }],
    });
  });

  it('reports an exec plus tree and identity-recovered provider descendants', async () => {
    const report = await sampleMemoryUsage({
      kind: 'exec',
      pid: 20,
      supplementaryPids: [40],
      snapshot: async () => [
        { pid: 20, ppid: 1, memoryKiB: 100 },
        { pid: 21, ppid: 20, memoryKiB: 200 },
        { pid: 40, ppid: 1, memoryKiB: 300 },
      ],
    });
    expect(report.status).toBe(MEMORY_REPORT_STATUS.OK);
    if (report.status !== MEMORY_REPORT_STATUS.OK) throw new Error('expected success');
    expect(report.rows.map((row) => [row.pid, row.role])).toEqual([
      [20, MEMORY_PROCESS_ROLE.EXEC],
      [21, MEMORY_PROCESS_ROLE.PROVIDER],
      [40, MEMORY_PROCESS_ROLE.PROVIDER],
    ]);
  });

  it('returns an explicit error report without empty rows', async () => {
    const report = await sampleMemoryUsage({
      kind: 'exec',
      snapshot: async () => { throw new Error('ps unavailable'); },
    });
    expect(report).toMatchObject({
      type: MEMORY_WIRE_TYPE.USAGE,
      status: MEMORY_REPORT_STATUS.ERROR,
      error: 'ps unavailable',
    });
    expect(report).not.toHaveProperty('rows');
  });
});

describe('scheduleInitialMemoryReport', () => {
  it('runs once after the shared warm-up delay', async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    scheduleInitialMemoryReport(report);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(report).toHaveBeenCalledTimes(1);
  });
});
