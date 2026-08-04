import { app, type ProcessMetric } from 'electron';
import type { AgentProvider, Connection } from '@shared/types';
import { CHANNEL_LOG } from '@shared/channel-log';
import {
  MEM_INITIAL_SAMPLE_DELAY_MS,
  MEM_RENDERER_PUBLISH_INTERVAL_MS,
  MEM_SAMPLE_INTERVAL_MS,
  MEM_SOURCE_STALE_AFTER_MS,
  MEMORY_AVAILABILITY,
  MEMORY_PROCESS_ROLE,
  MEMORY_REPORT_STATUS,
  MEMORY_WIRE_TYPE,
  connectionScopeKey,
  type MemoryProcessRole,
  type MemoryRollup,
  type ProcessMemorySummary,
  type MemoryUsageReport,
} from '@shared/process-memory';
import { channelLog } from './channel-log';
import { mapElectronAppMetrics } from './app-memory';
import { requestAllAgentMemoryUsage } from './agent/remote';
import { getProjects } from './app-state';

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
const knownTabScopes = new Set<string>();

export function registerExecMemorySource(
  tabId: string,
  provider: AgentProvider,
  connection: Connection,
): void {
  knownTabScopes.add(tabId);
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

export function forgetExecMemoryScope(tabId: string): void {
  knownTabScopes.delete(tabId);
  unregisterExecMemorySource(tabId);
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

function rollup(
  sources: MemorySourceState[],
  nowMs: number,
  roles?: ReadonlySet<MemoryProcessRole>,
): MemoryRollup {
  if (sources.length === 0) {
    return { availability: MEMORY_AVAILABILITY.AVAILABLE, memoryKiB: 0, excludedSources: 0 };
  }
  const fresh = sources.filter((source) =>
    source.report !== undefined
    && source.lastSuccessReceivedAt !== undefined
    && nowMs - source.lastSuccessReceivedAt <= MEM_SOURCE_STALE_AFTER_MS);
  const excludedSources = sources.length - fresh.length;
  if (fresh.length === 0) {
    return { availability: MEMORY_AVAILABILITY.UNAVAILABLE, excludedSources };
  }
  const memoryKiB = fresh.reduce((total, source) => total + source.report!.rows.reduce(
    (sourceTotal, row) => sourceTotal + (roles === undefined || roles.has(row.role) ? row.memoryKiB : 0),
    0,
  ), 0);
  return { availability: MEMORY_AVAILABILITY.AVAILABLE, memoryKiB, excludedSources };
}

const APP_ROLES = new Set<MemoryProcessRole>([
  MEMORY_PROCESS_ROLE.APP_BROWSER,
  MEMORY_PROCESS_ROLE.APP_RENDERER,
  MEMORY_PROCESS_ROLE.APP_GPU,
  MEMORY_PROCESS_ROLE.APP_UTILITY,
  MEMORY_PROCESS_ROLE.APP_OTHER,
]);
const RUNTIME_ROLES = new Set<MemoryProcessRole>([
  MEMORY_PROCESS_ROLE.DISPATCHER,
  MEMORY_PROCESS_ROLE.EXEC,
]);
const AGENT_ROLES = new Set<MemoryProcessRole>([MEMORY_PROCESS_ROLE.PROVIDER]);
const TAB_ROLES = new Set<MemoryProcessRole>([
  MEMORY_PROCESS_ROLE.EXEC,
  MEMORY_PROCESS_ROLE.PROVIDER,
]);

export function computeProcessMemorySummary(options: {
  sources: MemorySourceState[];
  connectionScopeKeys: Iterable<string>;
  tabIds: Iterable<string>;
  now: Date;
}): ProcessMemorySummary {
  const nowMs = options.now.getTime();
  const appSources = options.sources.filter((state) => state.source.kind === 'app');
  const connections: Record<string, ReturnType<typeof connectionSummary>> = {};
  const scopeKeys = new Set(options.connectionScopeKeys);
  for (const state of options.sources) {
    if (state.source.kind !== 'app') scopeKeys.add(state.source.connectionScopeKey);
  }

  function connectionSummary(scopeKey: string) {
    const sources = options.sources.filter((state) =>
      state.source.kind !== 'app' && state.source.connectionScopeKey === scopeKey);
    const execSources = sources.filter((state) => state.source.kind === 'exec');
    const freshExecs = execSources.filter((state) =>
      state.report !== undefined
      && state.lastSuccessReceivedAt !== undefined
      && nowMs - state.lastSuccessReceivedAt <= MEM_SOURCE_STALE_AFTER_MS);
    return {
      runtime: rollup(sources, nowMs, RUNTIME_ROLES),
      agents: rollup(execSources, nowMs, AGENT_ROLES),
      agentCount: new Set(freshExecs.map((state) => state.source.kind === 'exec' ? state.source.tabId : '')).size,
    };
  }

  for (const scopeKey of scopeKeys) connections[scopeKey] = connectionSummary(scopeKey);

  const tabs: Record<string, MemoryRollup> = {};
  const tabIds = new Set(options.tabIds);
  for (const state of options.sources) {
    if (state.source.kind === 'exec') tabIds.add(state.source.tabId);
  }
  for (const tabId of tabIds) {
    tabs[tabId] = rollup(options.sources.filter((state) =>
      state.source.kind === 'exec' && state.source.tabId === tabId), nowMs, TAB_ROLES);
  }

  const excludedSourceCount = options.sources.filter((source) =>
    source.report === undefined
    || source.lastSuccessReceivedAt === undefined
    || nowMs - source.lastSuccessReceivedAt > MEM_SOURCE_STALE_AFTER_MS).length;

  return {
    summarizedAt: options.now.toISOString(),
    app: rollup(appSources, nowMs, APP_ROLES),
    connections,
    tabs,
    excludedSourceCount,
  };
}

interface ProcessMemoryRuntimeDeps {
  getAppMetrics: () => ProcessMetric[];
  requestAgents: () => void;
  getConnectionScopeKeys?: () => Iterable<string>;
  getTabIds?: () => Iterable<string>;
  publishSummary?: (summary: ProcessMemorySummary) => void;
  recordSummary?: (summary: ProcessMemorySummary) => void;
  now?: () => Date;
}

export function createProcessMemoryRuntime(deps: ProcessMemoryRuntimeDeps) {
  let initialTimer: NodeJS.Timeout | undefined;
  let sampleTimer: NodeJS.Timeout | undefined;
  let summaryTimer: NodeJS.Timeout | undefined;
  let latestSummary: ProcessMemorySummary | null = null;
  const now = deps.now ?? (() => new Date());

  function sampleApp(): void {
    const sampledAt = now().toISOString();
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

  function runSummary(): ProcessMemorySummary {
    const summary = computeProcessMemorySummary({
      sources: registry.snapshot(),
      connectionScopeKeys: deps.getConnectionScopeKeys?.() ?? [],
      tabIds: deps.getTabIds?.() ?? [],
      now: now(),
    });
    latestSummary = summary;
    deps.recordSummary?.(summary);
    deps.publishSummary?.(summary);
    return summary;
  }

  function start(): void {
    registry.register({ id: 'app', kind: 'app' });
    initialTimer = setTimeout(sampleApp, MEM_INITIAL_SAMPLE_DELAY_MS);
    initialTimer.unref?.();
    sampleTimer = setInterval(runRound, MEM_SAMPLE_INTERVAL_MS);
    sampleTimer.unref?.();
    summaryTimer = setInterval(runSummary, MEM_RENDERER_PUBLISH_INTERVAL_MS);
    summaryTimer.unref?.();
  }

  function stop(): void {
    if (initialTimer) clearTimeout(initialTimer);
    if (sampleTimer) clearInterval(sampleTimer);
    if (summaryTimer) clearInterval(summaryTimer);
    initialTimer = undefined;
    sampleTimer = undefined;
    summaryTimer = undefined;
    registry.clear();
    knownTabScopes.clear();
    latestSummary = null;
  }

  return { start, stop, sampleApp, runRound, runSummary, getLatestSummary: () => latestSummary };
}

let summarySink: ((summary: ProcessMemorySummary) => void) | undefined;

const processMemoryRuntime = createProcessMemoryRuntime({
  getAppMetrics: () => app.getAppMetrics(),
  requestAgents: requestAllAgentMemoryUsage,
  getConnectionScopeKeys: () => getProjects().map((project) => connectionScopeKey(project.connection)),
  getTabIds: () => knownTabScopes,
  recordSummary: (summary) => channelLog(
    CHANNEL_LOG.MEMORY_SUMMARY,
    'info',
    'memory-summary',
    JSON.stringify(summary),
  ),
  publishSummary: (summary) => summarySink?.(summary),
});

export function setProcessMemorySummarySink(sink: ((summary: ProcessMemorySummary) => void) | undefined): void {
  summarySink = sink;
}

export function getCurrentProcessMemorySummary(): ProcessMemorySummary | null {
  return processMemoryRuntime.getLatestSummary();
}

export function initProcessMemory(): void {
  processMemoryRuntime.start();
}

export function disposeProcessMemory(): void {
  processMemoryRuntime.stop();
}
