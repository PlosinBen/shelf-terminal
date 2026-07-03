---
type: architecture
title: Connection Lifecycle
related:
  - context/connector
  - context/connection-health
  - context/deployment
---

# Connection Lifecycle

A project connection is established through one uniform pathway regardless of where the work actually runs — same machine, a remote host over a secure channel, a Windows Linux subsystem, or a container. The app holds the user's source of truth and drives every connection; each connection target hosts its own server-side runtime that the app spawns, feeds, and keeps alive. The shape below is identical across transports; only the lowest layer that moves bytes (spawn shell, run one-off command, copy a file) differs per target, and that difference is hidden behind a single connector role so nothing upstream branches on the target kind.

## Flow

```
[App / project]
      │  open a project on a chosen target (same-machine / remote / subsystem / container)
      ▼
[Connector]  ── one abstraction per target kind, selected by target + host OS ──
      │  it owns all target-specific work; everything above treats targets uniformly
      │
      ├─► [Interactive shell channel]  ── long-lived terminal session for the user
      │
      └─► [Command channel]  ── short, non-interactive one-shot commands (e.g. version-control ops)
      │
      ▼
[Deploy transport]  ── push runtime + projected per-app data to the target's server area ──
      │  • version-keyed runtime payload: copied once, shared across apps, skipped if already present
      │  • per-app projected data: mirror-replace, gated by a content fingerprint (re-push only on change)
      │  • same mechanism for every target; only the copy primitive changes
      ▼
[Agent-server]  ── one spawned per connection on the target; one app drives many servers (m:n) ──
      │  reads/writes only the target's own home-rooted server area; never the app's private store
      │
      ▼
[Heartbeat tracker]  ── steady ping/pong between app and agent-server ──
      │  one beat serves three ends:
      │   1. health UX     → app-side round-trip timing → 5 health states → per-project status indicator
      │   2. cleanup lease → each beat refreshes a liveness marker on the runtime dir + this app's data dir
      │   3. dead sensing  → consecutive misses → reported to UI only (no automatic kill)
      │
      ▼
[Idle-shutdown watchdog]  ── lives inside the agent-server, armed ONLY when the target is an
                              independent remote host (one not co-suspended with the app) ──
          each beat resets it; on timeout it reaps its escaped background tasks (below),
          disposes its backends, and exits, so an idle remote stops burning resources
          while the app sleeps. Co-located targets (same-machine / subsystem / container)
          are never armed — they sleep with the app.
```

## Boundaries

- **Target-specifics live only in the connector.** Selecting the runtime, opening a shell, running a one-shot command, listing a directory, uploading, and cleanup are all resolved inside the per-target abstraction. Nothing above it switches on the target kind; adding a new target kind is adding one connector, not editing every call site. The bridge that exposes capabilities to the UI is a plain pass-through with no dispatch of its own.

- **Source of truth flows one way.** The app owns the canonical user data; the server area on each target holds only derived, disposable projections that can be rebuilt at any time. Projection is always a push from app to target over the deploy transport — the app never reaches in to read or write the target's filesystem directly, and reads back only the small markers it deployed. Local is not a special case: it projects to the same home-rooted server area as remote targets so the server-side code stays branch-free.

- **The runtime and per-app data are keyed differently on purpose.** Byte-identical runtime payloads are version-keyed and shared across apps to avoid re-copying large binaries; per-app content is keyed per app so multiple apps on one shared host never overwrite each other. Because one host can serve many apps, reclamation is never an eager "delete everything but mine" — it is a lease sweep: each live server refreshes liveness markers, and stale, unreferenced entries are reclaimed on the next startup sweep.

- **Heartbeat timing is single-clocked.** Round-trip health is computed entirely on the app side; the two endpoints' clocks are never compared, because there is no clock synchronization between them.

- **Dead is not death.** A connection flagged dead from missed beats is surfaced to the UI but never auto-killed by the app: a sleeping laptop produces frequent false "dead → instantly healthy" flaps, so killing on dead would destroy healthy sessions wholesale. The only autonomous teardown is the agent-server's own idle-shutdown watchdog, and it is gated on whether the host is co-suspended with the app — armed for an independent remote host, deliberately absent for co-located targets. The cost is that a long idle remote will self-exit; surviving background work is opt-in by disabling the watchdog for that host, and otherwise the connection is re-spawned and resumed on wake.

- **Teardown reaps the background work the agent left running.** An agent can start background shell tasks that detach out of its own process tree, so the ordinary teardown cascade cannot reach them. The classification is normal-vs-abnormal closure, owned by the agent-server itself: on any NORMAL closure — for any reason, including a disconnect it detects (its input closing, or the idle watchdog firing) — it is still alive, so it first reaps those escaped tasks (enumerate them, then have each provider stop its own) before disposing. This is unconditional, because there is no reconnect: a reconnect is a fresh connection, and any task left running would be permanently invisible and uncontrollable, so it is cleaned up rather than orphaned. The one case it cannot cover — the agent-server dying ABNORMALLY (a hard crash), before it can run that path — is caught by the same startup lease sweep that reclaims stale dirs: each server stamps its spawned processes with a per-session marker and records a liveness lease; the next server to start reaps any still-alive marked processes whose owning session is provably gone (a normal shutdown drops its own lease, so a lingering one means a crash). That process-level sweep only works where the host exposes a process table for it; where it does not, an abnormally-orphaned local task is left for the user — low-severity and visible locally.
