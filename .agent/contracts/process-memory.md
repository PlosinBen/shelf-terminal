---
type: contract
title: Process Memory Contracts
related:
  - architecture/process-memory-observability
  - contracts/agent-wire-protocol
  - contracts/ipc-channels
  - contracts/persistence-formats
  - context/process-memory-observability
---

# Process Memory Contracts

Authoritative constants and TypeScript shapes are in `src/shared/process-memory.ts`; platform acquisition is in `src/shared/process-memory-sampler.ts`.

## Acquisition messages

Main requests a snapshot with one line-delimited command:

```json
{"type":"get_memory_usage"}
```

A successful source response carries normalized resident-memory rows in KiB:

```json
{
  "type": "memory_usage",
  "status": "ok",
  "sampledAt": "2026-08-05T00:00:00.000Z",
  "rows": [
    { "pid": 123, "ppid": 1, "memoryKiB": 4096, "role": "dispatcher" }
  ]
}
```

A failed attempt contains no rows:

```json
{
  "type": "memory_usage",
  "status": "error",
  "sampledAt": "2026-08-05T00:00:00.000Z",
  "error": "process snapshot failed"
}
```

| Field | Type | Meaning |
|---|---|---|
| `sampledAt` | ISO timestamp | Source-clock diagnostic metadata; not used for freshness. |
| `rows[].pid` | positive safe integer | Observed process id. |
| `rows[].ppid` | non-negative safe integer, optional | Observed parent process id. |
| `rows[].memoryKiB` | non-negative safe integer | Normalized resident-memory value; one KiB is 1024 bytes. |
| `rows[].role` | `app-browser \| app-renderer \| app-gpu \| app-utility \| app-other \| dispatcher \| exec \| provider` | Shelf-owned attribution, independent of platform field names. |

Dispatcher reports are host-level and carry no `sid`. Exec reports carry their session `sid` only as a routing envelope; main validates the report and removes the routing field before storing it. A dispatcher request samples the dispatcher and fans the same request to its current execs. The direct-exec fallback routes the same command/report shape without a dispatcher.

## Platform adapter inputs

| Runtime platform | Acquisition source | Source value normalized to `memoryKiB` |
|---|---|---|
| macOS | process-list snapshot | RSS already reported in KiB |
| Linux, including WSL | process-list snapshot; procfs fallback | RSS / `VmRSS`, both KiB |
| Windows local | process-management working-set snapshot | `WorkingSetSize` bytes converted to KiB |

The short-lived acquisition child is excluded. Exec classification includes the exec root plus its descendant provider processes; Linux may supplement tree discovery with session-tagged process ids. Dispatcher classification includes only dispatcher self.

## Summary snapshot

`ProcessMemorySummary` is the complete object sent to renderer and written to the summary log:

```ts
interface ProcessMemorySummary {
  summarizedAt: string;
  app: MemoryRollup;
  connections: Record<string, {
    runtime: MemoryRollup;
    agents: MemoryRollup;
    agentCount: number;
  }>;
  tabs: Record<string, MemoryRollup>;
  excludedSourceCount: number;
}

interface MemoryRollup {
  availability: 'available' | 'unavailable';
  memoryKiB?: number;
  excludedSources: number;
}
```

Connection keys are `local`, `ssh:<host>:<port>:<user>`, `docker:<container>`, or `wsl:<distro>`; passwords are never included. Runtime is dispatcher plus exec memory. Agents is provider-descendant memory, and `agentCount` counts fresh exec/tab sources rather than descendant processes. A tab rollup is exec plus provider memory and excludes App and dispatcher.

Fresh sources contribute to partial subtotals. Relevant sources with no fresh success produce `unavailable`; a valid empty source set produces available zero. A failed attempt does not replace or refresh the last successful value. Freshness expires after two five-minute sample intervals plus one 30-second publication interval.

## Timing

| Constant | Value | Behavior |
|---|---:|---|
| `MEM_INITIAL_SAMPLE_DELAY_MS` | 10 seconds | One source-local warm-up report after source activation. |
| `MEM_SAMPLE_INTERVAL_MS` | 5 minutes | Main acquisition round; no response barrier. |
| `MEM_RENDERER_PUBLISH_INTERVAL_MS` | 30 seconds | Unconditional summary recompute, log, cache, and renderer push. |
| `MEM_SOURCE_STALE_AFTER_MS` | 10 minutes 30 seconds | Successful source value stops contributing after this age. |

Renderer stores the complete summary without re-aggregation. Values below 1 GiB display as whole MiB, values at or above 1 GiB as one-decimal GiB, available zero as `0 MiB`, and unavailable as `—`.
