import React from 'react';
import { MEMORY_AVAILABILITY, type MemoryRollup, type ProcessMemorySummary } from '@shared/process-memory';

const KIB_PER_MIB = 1024;
const KIB_PER_GIB = 1024 * KIB_PER_MIB;

export function formatMemoryKiB(rollup: MemoryRollup | null | undefined): string {
  if (rollup?.availability !== MEMORY_AVAILABILITY.AVAILABLE || rollup.memoryKiB === undefined) {
    return '—';
  }
  if (rollup.memoryKiB < KIB_PER_GIB) {
    return `${Math.round(rollup.memoryKiB / KIB_PER_MIB)} MiB`;
  }
  return `${(rollup.memoryKiB / KIB_PER_GIB).toFixed(1)} GiB`;
}

export function FooterMemory({
  summary,
  selectedConnectionScopeKey,
}: {
  summary: ProcessMemorySummary | null;
  selectedConnectionScopeKey?: string;
}) {
  const connection = selectedConnectionScopeKey
    ? summary?.connections[selectedConnectionScopeKey]
    : undefined;

  return (
    <div className="bottom-bar-memory" aria-label="Process memory usage">
      <span className="bottom-bar-memory-app">App {formatMemoryKiB(summary?.app)}</span>
      <span className="bottom-bar-memory-separator">|</span>
      <span className="bottom-bar-memory-runtime">Runtime {formatMemoryKiB(connection?.runtime)}</span>
      <span className="bottom-bar-memory-separator">|</span>
      <span className="bottom-bar-memory-agents">
        Agents({connection?.agentCount ?? 0}) {formatMemoryKiB(connection?.agents)}
      </span>
    </div>
  );
}

export function AgentMemory({ rollup }: { rollup: MemoryRollup | null | undefined }) {
  return <span className="agent-status-seg agent-status-memory">Memory {formatMemoryKiB(rollup)}</span>;
}
