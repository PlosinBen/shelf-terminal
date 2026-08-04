import type { ProcessMetric } from 'electron';
import {
  MEMORY_PROCESS_ROLE,
  type MemoryProcessRole,
  type ProcessMemoryRow,
} from '@shared/process-memory';

function electronRole(type: ProcessMetric['type']): MemoryProcessRole {
  switch (type) {
    case 'Browser':
      return MEMORY_PROCESS_ROLE.APP_BROWSER;
    case 'Tab':
      return MEMORY_PROCESS_ROLE.APP_RENDERER;
    case 'GPU':
      return MEMORY_PROCESS_ROLE.APP_GPU;
    case 'Utility':
      return MEMORY_PROCESS_ROLE.APP_UTILITY;
    default:
      return MEMORY_PROCESS_ROLE.APP_OTHER;
  }
}

/** Electron reports workingSetSize in KiB; no platform field leaks past this boundary. */
export function mapElectronAppMetrics(metrics: ProcessMetric[]): ProcessMemoryRow[] {
  return metrics.map((metric) => {
    const memoryKiB = metric.memory.workingSetSize;
    if (!Number.isSafeInteger(metric.pid) || metric.pid <= 0) {
      throw new Error(`invalid Electron process pid: ${String(metric.pid)}`);
    }
    if (!Number.isSafeInteger(memoryKiB) || memoryKiB < 0) {
      throw new Error(`invalid Electron workingSetSize for pid ${metric.pid}: ${String(memoryKiB)}`);
    }
    return {
      pid: metric.pid,
      memoryKiB,
      role: electronRole(metric.type),
    };
  });
}
