import { describe, expect, it } from 'vitest';
import type { ProcessMetric } from 'electron';
import { MEMORY_PROCESS_ROLE } from '@shared/process-memory';
import { mapElectronAppMetrics } from './app-memory';

function metric(pid: number, type: ProcessMetric['type'], workingSetSize: number): ProcessMetric {
  return {
    pid,
    type,
    creationTime: 0,
    cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize, peakWorkingSetSize: workingSetSize },
  };
}

describe('mapElectronAppMetrics', () => {
  it('uses Electron process types and preserves working-set KiB', () => {
    expect(mapElectronAppMetrics([
      metric(1, 'Browser', 100),
      metric(2, 'Tab', 200),
      metric(3, 'GPU', 300),
      metric(4, 'Utility', 400),
      metric(5, 'Zygote', 500),
    ])).toEqual([
      { pid: 1, memoryKiB: 100, role: MEMORY_PROCESS_ROLE.APP_BROWSER },
      { pid: 2, memoryKiB: 200, role: MEMORY_PROCESS_ROLE.APP_RENDERER },
      { pid: 3, memoryKiB: 300, role: MEMORY_PROCESS_ROLE.APP_GPU },
      { pid: 4, memoryKiB: 400, role: MEMORY_PROCESS_ROLE.APP_UTILITY },
      { pid: 5, memoryKiB: 500, role: MEMORY_PROCESS_ROLE.APP_OTHER },
    ]);
  });

  it('rejects malformed working-set values', () => {
    expect(() => mapElectronAppMetrics([metric(1, 'Browser', Number.NaN)])).toThrow(
      'invalid Electron workingSetSize',
    );
  });
});
