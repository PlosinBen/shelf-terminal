---
type: architecture
title: Process Memory Observability
related:
  - contracts/process-memory
  - context/process-memory-observability
  - architecture/agent-dispatch
---

# Process Memory Observability

Shelf measures each participating process at its owning runtime, brings normalized reports into one app-level current-state registry, and derives coarse user rollups plus retained diagnostics from that shared state.

## Flow

```text
Source activation ──10s warm-up──┐
                                ├─→ App / dispatcher / exec acquisition
Main acquisition clock ──5m─────┘              │
                                               ▼
                                     Source-owned memory report
                                               │
                                               ▼
                                   Main latest-value registry
                                               │
                            ┌──────────────────┴──────────────────┐
                            ▼                                     ▼
                    Per-source retained log             30s summary clock
                                                                  │
                                            ┌─────────────────────┴──────────────┐
                                            ▼                                    ▼
                                  Retained summary log                 Renderer snapshot
                                                                                 │
                                                             ┌───────────────────┴─────────────┐
                                                             ▼                                 ▼
                                                    Active-connection footer          Per-tab status bar
```

Each dispatcher reports only itself. Each session execution unit reports itself and its provider descendants. Main samples the local app process fleet, validates every incoming report independently, and never waits for a round-wide response set.

## Boundaries

- Acquisition ownership follows the process: main measures app processes, while dispatcher and session runtimes measure their own host-local processes. Remote transport changes routing, not sampling semantics.
- Memory freshness is based on main receive time. Source clocks are retained for diagnosis but do not control eligibility.
- Memory availability is not liveness. Heartbeat and child-exit handling remain responsible for process health; missing memory reports only age out of rollups.
- User surfaces receive complete summaries, never per-process rows. Detailed rows remain in main current state and retained source logs.
- Terminal shells and detached processes without a supported identity signal are outside the measured fleet.
