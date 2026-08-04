import { app, type ProcessMetric } from 'electron';
import type { AgentProvider, Connection } from '@shared/types';
import { CHANNEL_LOG } from '@shared/channel-log';
import {
  MEM_INITIAL_SAMPLE_DELAY_MS,
  MEM_SAMPLE_INTERVAL_MS,
  MEMORY_PROCESS_ROLE,
  MEMORY_REPORT_STATUS,
  MEMORY_WIRE_TYPE,
  connectionScopeKey,
  type MemoryUsageReport,
} from '@shared/process-memory';
import { channelLog } from './channel-log';
import { mapElectronAppMetrics } from './app-memory';
import { requestAllAgentMemoryUsage } from './agent/remote';

export type MemorySource =
  | { id: 'app'; kind: 'app' }
  | { id: string; kind: 'dispatcher'; connectionScopeKey: string }
  | { id: string; kind: 'exec'; connectionScopeKey: string; tabId: string; provider: AgentProvider };

export interface MemorySourceState {
  source: MemorySource;
  report?: Extract<MemoryUsageReport, { status: 'ok' }>;
  lastSuccessReceivedAt?: number;
}

export interface MemorySourceRecord {
  receivedAt: string;
  sourceId: string;
  source?: MemorySource;
  accepted: boolean;
  reason?: string;
  report: MemoryUsageReport;
}

interface MemoryRegistryOptions {
  now?: () => Date;
  record?: (record: MemorySourceRecord) => void;
}

export function dispatcherMemorySourceId(scopeKey: string): string {
  return `dispatcher:${scopeKey}`;
}

export function execMemorySourceId(tabId: string): string {
  return `exec:${tabId}`;
}

export function createProcessMemoryRegistry(options: MemoryRegistryOptions = {}) {
  const sources = new Map<string, MemorySourceState>();
  const now = options.now ?? (() => new Date());
  const record = options.record ?? (() => {});

  function register(source: MemorySource): void {
    sources.set(source.id, { source });
  }

  function unregister(sourceId: string): void {
    sources.delete(sourceId);
  }

  function accept(sourceId: string, report: MemoryUsageReport): boolean {
    const receivedAt = now();
    const state = sources.get(sourceId);
    if (!state) {
      record({
        receivedAt: receivedAt.toISOString(),
        sourceId,
        accepted: false,
        reason: 'source is not registered',
        report,
      });
      return false;
    }

    record({ receivedAt: receivedAt.toISOString(), sourceId, source: state.source, accepted: true, report });
    if (report.status === MEMORY_REPORT_STATUS.OK) {
      state.report = report;
      state.lastSuccessReceivedAt = receivedAt.getTime();
    }
    return true;
  }

  function snapshot(): MemorySourceState[] {
    return Array.from(sources.values(), (state) => ({
      ...state,
      source: { ...state.source },
      report: state.report ? { ...state.report, rows: state.report.rows.map((row) => ({ ...row })) } : undefined,
    }));
  }

  function clear(): void {
    sources.clear();
  }

  return { register, unregister, accept, snapshot, clear };
}

function writeSourceRecord(record: MemorySourceRecord): void {
  channelLog(
    CHANNEL_LOG.MEMORY,
    record.accepted && record.report.status === MEMORY_REPORT_STATUS.OK ? 'info' : 'warn',
    'memory',
    JSON.stringify(record),
  );
}

const registry = createProcessMemoryRegistry({ record: writeSourceRecord });

export function registerExecMemorySource(
  tabId: string,
  provider: AgentProvider,
  connection: Connection,
): void {
  registry.register({
    id: execMemorySourceId(tabId),
    kind: 'exec',
    connectionScopeKey: connectionScopeKey(connection),
    tabId,
    provider,
  });
}

export function unregisterExecMemorySource(tabId: string): void {
  registry.unregister(execMemorySourceId(tabId));
}

export function acceptExecMemoryReport(tabId: string, report: MemoryUsageReport): boolean {
  return registry.accept(execMemorySourceId(tabId), report);
}

export function registerDispatcherMemorySource(connection: Connection): void {
  const scopeKey = connectionScopeKey(connection);
  registry.register({
    id: dispatcherMemorySourceId(scopeKey),
    kind: 'dispatcher',
    connectionScopeKey: scopeKey,
  });
}

export function unregisterDispatcherMemorySource(connection: Connection): void {
  registry.unregister(dispatcherMemorySourceId(connectionScopeKey(connection)));
}

export function acceptDispatcherMemoryReport(connection: Connection, report: MemoryUsageReport): boolean {
  return registry.accept(dispatcherMemorySourceId(connectionScopeKey(connection)), report);
}

export function getProcessMemorySourceStates(): MemorySourceState[] {
  return registry.snapshot();
}

interface ProcessMemoryRuntimeDeps {
  getAppMetrics: () => ProcessMetric[];
  requestAgents: () => void;
}

export function createProcessMemoryRuntime(deps: ProcessMemoryRuntimeDeps) {
  let initialTimer: NodeJS.Timeout | undefined;
  let sampleTimer: NodeJS.Timeout | undefined;

  function sampleApp(): void {
    const sampledAt = new Date().toISOString();
    let report: MemoryUsageReport;
    try {
      report = {
        type: MEMORY_WIRE_TYPE.USAGE,
        status: MEMORY_REPORT_STATUS.OK,
        sampledAt,
        rows: mapElectronAppMetrics(deps.getAppMetrics()),
      };
    } catch (error) {
      report = {
        type: MEMORY_WIRE_TYPE.USAGE,
        status: MEMORY_REPORT_STATUS.ERROR,
        sampledAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    registry.accept('app', report);
  }

  function runRound(): void {
    sampleApp();
    deps.requestAgents();
  }

  function start(): void {
    registry.register({ id: 'app', kind: 'app' });
    initialTimer = setTimeout(sampleApp, MEM_INITIAL_SAMPLE_DELAY_MS);
    initialTimer.unref?.();
    sampleTimer = setInterval(runRound, MEM_SAMPLE_INTERVAL_MS);
    sampleTimer.unref?.();
  }

  function stop(): void {
    if (initialTimer) clearTimeout(initialTimer);
    if (sampleTimer) clearInterval(sampleTimer);
    initialTimer = undefined;
    sampleTimer = undefined;
    registry.clear();
  }

  return { start, stop, sampleApp, runRound };
}

const processMemoryRuntime = createProcessMemoryRuntime({
  getAppMetrics: () => app.getAppMetrics(),
  requestAgents: requestAllAgentMemoryUsage,
});

export function initProcessMemory(): void {
  processMemoryRuntime.start();
}

export function disposeProcessMemory(): void {
  processMemoryRuntime.stop();
}
