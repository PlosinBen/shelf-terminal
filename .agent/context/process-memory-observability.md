---
type: context
title: Process Memory Observability
related:
  - architecture/process-memory-observability
  - contracts/process-memory
  - context/connection-health
---

# Process Memory Observability

## process-memory-observability#1 — Main schedules acquisition; each runtime owns measurement  ·  [Decision]

**Decision:** Main starts one acquisition round every five minutes and requests all current routes. Main measures the local app fleet; each dispatcher measures only itself; each session exec measures itself plus provider descendants. Every source also emits one independent warm-up report ten seconds after activation.

**Reason:** Main has the complete route inventory and can avoid one recurring timer per process, while only the process-local runtime can enumerate the correct local or remote host. The initial report makes newly started sources observable without coupling their lifetime to the global clock.

**Do not change casually because:** Moving remote enumeration into main breaks the same semantics across local, SSH, Docker, and WSL. Adding independent recurring source timers creates aligned or drifting bursts without improving ownership. Overlapping warm-up and periodic requests are intentionally allowed; both samples are cheap and later arrival wins.

## process-memory-observability#2 — Normalize resident memory to KiB at the adapter boundary  ·  [Decision]

**Decision:** The only numeric memory measure downstream is non-negative integer `memoryKiB`. Platform field names and byte conversion remain inside adapters. Roles, not process names, determine App, Runtime, Agent, and per-tab attribution.

**Reason:** A single resident-memory measure keeps cross-platform rollups interpretable. Exposing platform-specific field names in events would leak acquisition details into routing, storage, and renderer without adding user value.

**Do not change casually because:** Mixing resident memory with footprint/private metrics creates totals that add unlike quantities. Treat rollups as rough gauges because resident sets can share physical pages. WSL follows the Linux adapter because acquisition runs inside the WSL runtime; WSL is only the outer transport.

## process-memory-observability#3 — Latest-value summaries are cadence-decoupled from source reports and liveness  ·  [Decision]

**Decision:** Main records each source attempt immediately, retains only the latest successful source value for aggregation, and unconditionally computes one complete summary every 30 seconds for both summary logging and renderer publication. Freshness uses main receive time and expires after two sample intervals plus one publication interval. Heartbeat state does not mutate memory state.

**Reason:** Independent source arrival avoids an all-sources barrier and makes a dispatcher burst harmless. One summary object feeding log and UI prevents drift, while the fixed publication cadence is simpler than dirty/debounce coordination. Local receive time avoids clock-skew logic; source timestamps remain diagnostic context.

**Do not change casually because:** A failed attempt must not erase a still-fresh success, and a stale success must not remain displayed forever. Intentional unregister removes a source immediately; unexpected silence ages out. A missing memory report is not proof of death—heartbeat and process-exit paths own liveness. Renderer hydration must register the push listener before reading the cached snapshot, and a push received while the getter is pending must win over the older getter response.
