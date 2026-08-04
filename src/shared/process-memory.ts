import type { Connection } from './types';

export const MEMORY_WIRE_TYPE = {
  GET_USAGE: 'get_memory_usage',
  USAGE: 'memory_usage',
} as const;

export const MEMORY_REPORT_STATUS = {
  OK: 'ok',
  ERROR: 'error',
} as const;

export const MEMORY_PROCESS_ROLE = {
  APP_BROWSER: 'app-browser',
  APP_RENDERER: 'app-renderer',
  APP_GPU: 'app-gpu',
  APP_UTILITY: 'app-utility',
  APP_OTHER: 'app-other',
  DISPATCHER: 'dispatcher',
  EXEC: 'exec',
  PROVIDER: 'provider',
} as const;

export type MemoryProcessRole = typeof MEMORY_PROCESS_ROLE[keyof typeof MEMORY_PROCESS_ROLE];
export type MemoryReportStatus = typeof MEMORY_REPORT_STATUS[keyof typeof MEMORY_REPORT_STATUS];

export const MEM_INITIAL_SAMPLE_DELAY_MS = 10_000;
export const MEM_SAMPLE_INTERVAL_MS = 5 * 60_000;
export const MEM_RENDERER_PUBLISH_INTERVAL_MS = 30_000;
export const MEM_SOURCE_STALE_AFTER_MS =
  2 * MEM_SAMPLE_INTERVAL_MS + MEM_RENDERER_PUBLISH_INTERVAL_MS;

export interface ProcessMemorySample {
  pid: number;
  ppid?: number;
  memoryKiB: number;
}

export interface ProcessMemoryRow extends ProcessMemorySample {
  role: MemoryProcessRole;
}

export interface MemoryUsageSuccessReport {
  type: typeof MEMORY_WIRE_TYPE.USAGE;
  status: typeof MEMORY_REPORT_STATUS.OK;
  sampledAt: string;
  rows: ProcessMemoryRow[];
}

export interface MemoryUsageFailureReport {
  type: typeof MEMORY_WIRE_TYPE.USAGE;
  status: typeof MEMORY_REPORT_STATUS.ERROR;
  sampledAt: string;
  error: string;
}

export type MemoryUsageReport = MemoryUsageSuccessReport | MemoryUsageFailureReport;

/** Stable, non-secret identity shared by dispatcher pooling and memory rollups. */
export function connectionScopeKey(connection: Connection): string {
  switch (connection.type) {
    case 'local':
      return 'local';
    case 'ssh':
      return `ssh:${connection.host}:${connection.port}:${connection.user}`;
    case 'docker':
      return `docker:${connection.container}`;
    case 'wsl':
      return `wsl:${connection.distro}`;
  }
}
