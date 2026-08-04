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

export const MEMORY_AVAILABILITY = {
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
} as const;

export type MemoryProcessRole = typeof MEMORY_PROCESS_ROLE[keyof typeof MEMORY_PROCESS_ROLE];
export type MemoryReportStatus = typeof MEMORY_REPORT_STATUS[keyof typeof MEMORY_REPORT_STATUS];
export type MemoryAvailability = typeof MEMORY_AVAILABILITY[keyof typeof MEMORY_AVAILABILITY];

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

export interface MemoryRollup {
  availability: MemoryAvailability;
  memoryKiB?: number;
  excludedSources: number;
}

export interface ConnectionMemorySummary {
  runtime: MemoryRollup;
  agents: MemoryRollup;
  agentCount: number;
}

export interface ProcessMemorySummary {
  summarizedAt: string;
  app: MemoryRollup;
  connections: Record<string, ConnectionMemorySummary>;
  tabs: Record<string, MemoryRollup>;
  excludedSourceCount: number;
}

const MEMORY_PROCESS_ROLES = new Set<string>(Object.values(MEMORY_PROCESS_ROLE));

/** Validate an untrusted wire payload and strip routing-only envelope fields. */
export function parseMemoryUsageReport(value: unknown): MemoryUsageReport {
  if (!value || typeof value !== 'object') throw new Error('memory_usage report must be an object');
  const report = value as Record<string, unknown>;
  if (report.type !== MEMORY_WIRE_TYPE.USAGE) throw new Error('unexpected memory report type');
  if (typeof report.sampledAt !== 'string' || Number.isNaN(Date.parse(report.sampledAt))) {
    throw new Error('memory_usage sampledAt must be an ISO timestamp');
  }

  if (report.status === MEMORY_REPORT_STATUS.ERROR) {
    if (typeof report.error !== 'string' || report.error.trim().length === 0) {
      throw new Error('failed memory_usage report requires an error');
    }
    if ('rows' in report) throw new Error('failed memory_usage report must not contain rows');
    return {
      type: MEMORY_WIRE_TYPE.USAGE,
      status: MEMORY_REPORT_STATUS.ERROR,
      sampledAt: report.sampledAt,
      error: report.error,
    };
  }

  if (report.status !== MEMORY_REPORT_STATUS.OK || !Array.isArray(report.rows)) {
    throw new Error('successful memory_usage report requires rows');
  }
  const rows = report.rows.map((raw, index): ProcessMemoryRow => {
    if (!raw || typeof raw !== 'object') throw new Error(`memory_usage row ${index} must be an object`);
    const row = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(row.pid) || Number(row.pid) <= 0) {
      throw new Error(`memory_usage row ${index} has invalid pid`);
    }
    if (row.ppid !== undefined && (!Number.isSafeInteger(row.ppid) || Number(row.ppid) < 0)) {
      throw new Error(`memory_usage row ${index} has invalid ppid`);
    }
    if (!Number.isSafeInteger(row.memoryKiB) || Number(row.memoryKiB) < 0) {
      throw new Error(`memory_usage row ${index} has invalid memoryKiB`);
    }
    if (typeof row.role !== 'string' || !MEMORY_PROCESS_ROLES.has(row.role)) {
      throw new Error(`memory_usage row ${index} has invalid role`);
    }
    return {
      pid: Number(row.pid),
      ...(row.ppid === undefined ? {} : { ppid: Number(row.ppid) }),
      memoryKiB: Number(row.memoryKiB),
      role: row.role as MemoryProcessRole,
    };
  });
  return {
    type: MEMORY_WIRE_TYPE.USAGE,
    status: MEMORY_REPORT_STATUS.OK,
    sampledAt: report.sampledAt,
    rows,
  };
}

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
