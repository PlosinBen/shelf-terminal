import {
  MEM_INITIAL_SAMPLE_DELAY_MS,
  MEMORY_PROCESS_ROLE,
  MEMORY_REPORT_STATUS,
  MEMORY_WIRE_TYPE,
  type MemoryUsageReport,
} from '@shared/process-memory';
import {
  classifyExecProcessTree,
  classifyProcessSelf,
  snapshotProcesses,
} from '@shared/process-memory-sampler';

interface MemoryReportOptions {
  kind: 'dispatcher' | 'exec';
  pid?: number;
  supplementaryPids?: readonly number[];
  now?: () => Date;
  snapshot?: typeof snapshotProcesses;
}

export async function sampleMemoryUsage(options: MemoryReportOptions): Promise<MemoryUsageReport> {
  const sampledAt = (options.now ?? (() => new Date()))().toISOString();
  try {
    const samples = await (options.snapshot ?? snapshotProcesses)();
    const pid = options.pid ?? process.pid;
    const rows = options.kind === 'dispatcher'
      ? [classifyProcessSelf(samples, pid, MEMORY_PROCESS_ROLE.DISPATCHER)]
      : classifyExecProcessTree(samples, pid, options.supplementaryPids);
    return {
      type: MEMORY_WIRE_TYPE.USAGE,
      status: MEMORY_REPORT_STATUS.OK,
      sampledAt,
      rows,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      type: MEMORY_WIRE_TYPE.USAGE,
      status: MEMORY_REPORT_STATUS.ERROR,
      sampledAt,
      error: detail || 'unknown process-memory sampling error',
    };
  }
}

export function scheduleInitialMemoryReport(
  report: () => void | Promise<void>,
  delayMs = MEM_INITIAL_SAMPLE_DELAY_MS,
): NodeJS.Timeout {
  const timer = setTimeout(() => { void report(); }, delayMs);
  timer.unref?.();
  return timer;
}
