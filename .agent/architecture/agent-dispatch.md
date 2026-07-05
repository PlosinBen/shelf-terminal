---
type: architecture
title: Agent Dispatch
related:
  - architecture/agent-turn
  - architecture/connection-lifecycle
  - contracts/agent-wire-protocol
  - context/connection-health
  - context/agent-config-flow
  - context/agent-core
---

# Agent Dispatch

How one host's many agent sessions are hosted, routed, and kept alive. The concern that varies here is process topology: dispatch (a provider-agnostic front that is always shareable per host) is split from provider execution (the unit that actually runs the CLI). The app process reaches a host over a single channel; on that host a thin long-lived front multiplexes every session for the host, and each session's actual work runs in an execution unit below the front. Sessions are addressed explicitly end to end, so which sessions share an execution unit — versus each getting their own — is a mapping policy, not a second architecture.

> A single-tier fallback (each session getting its own direct front, no shared dispatcher) is retained behind an escape-hatch flag as a temporary safety net for transports not yet exercised on the tiered path. It is scheduled for removal once the tiered path has proven itself on every transport; treat it as transitional, not a parallel design.

## Topology

```
[App process]  ── holds the user's source of truth; one channel per host ──
      │  addresses every message by session id (sid)
      │
   ═══╪═══  transport boundary (secure channel / subsystem / container / same-machine)
      │
[Per-host dispatcher]  ── ONE thin front per host, spawned on the first session, reused ──
      │  • demuxes by sid: routes each session's traffic to its execution unit
      │  • relays the token stream OPAQUELY (forwards without parsing)
      │  • peeks only the few messages it services locally (health pong, cache)
      │  • holds the model/capability cache (outlives any execution unit)
      │  • supervises execution units: liveness, reconnect, backoff
      │  • holds NO provider code (loaded lazily only in the execution role)
      │
      │  demux by sid
      ├─► [Execution unit A]  ── runs the provider harness ──▶ native CLI subprocess
      └─► [Execution unit B]  ── runs the provider harness ──▶ native CLI subprocess
```

The dispatcher and an execution unit are the same deployed artifact selected into a role at spawn; the front role is chosen first and never loads provider modules, so it starts fast and stays a small failure surface. The execution unit is a session-addressed harness: it demuxes by sid too, so it can host one session (the currently deployed shape) or many, without changing the wire between it and the front.

## Two-map hosting

Session hosting reduces to two maps held inside the execution tier:

- **sessions** — one entry per session id, carrying that session's own state.
- **runtimes** — one entry per *runtime key*, each owning a single provider SDK client.

Opening a session resolves a runtime key, gets-or-creates the runtime for that key, and creates the session on it. That key is the entire isolated-versus-shared policy:

- key = the session id → every session gets its own runtime → **isolated** (own client, own CLI each).
- key = provider-plus-account → all of a provider's sessions share one runtime → **shared** (one client, many sessions, one CLI).

Isolated and shared are therefore the same code path with the map holding one entry versus many — a policy knob, not a structural fork. A provider that cannot multiplex a client (one subprocess is one conversation) always keys by session id and falls into isolation automatically, with no special-casing. The currently deployed policy is isolated for every provider; the shared flip is a change of the key function alone.

## Addressing and opaque pass-through

Every session-scoped message on both boundaries carries the session id, and the front routes purely on it. Session-explicit addressing on both boundaries is what lets the front stay a dumb relay: it stamps outbound events with their session id and forwards inbound commands by session id, without understanding their contents. The one hard rule on the streaming hot path is that the front does **opaque pass-through** — it forwards stream data untouched and only intercepts the handful of messages it actually services (a health probe reply, a cache lookup). Parsing the stream would put heavy per-message work on the front and serialize the whole host's throughput through it; keeping it thin is both the performance rule and the stability rule (a thin front has little logic to crash and freezes nothing when it does).

## Health — two tiers

Health is checked at two independent levels, replacing the earlier single per-session heartbeat:

- **Outer (host level)**: the app beats against the dispatcher across the transport. A missed beat means the whole host is unreachable, so every session on that host is severed together — correct, because they share one channel.
- **Inner (per execution unit)**: the dispatcher beats against each execution unit locally on the host. A missed inner beat means that unit is hung (alive but its event loop is blocked — the known post-sleep / network-drop wedge), so only that one session is severed; the front and its siblings are untouched.

The inner tier is required, not optional: without it a wedged execution unit would ride under a dispatcher that keeps answering the outer beat, so the app would see the host healthy while one session is silently stuck. Stream silence cannot substitute for a probe, because an idle session is silent too.

## Connection-centric reconnect

Recovery is framed as reconnecting a session's provider execution, **not** respawning a worker. The dispatcher maintains, per session, a live connection to a provider execution; in isolated mode the execution process is merely that connection's current embodiment. On loss — the process exited ("gone"), or the inner probe went unanswered ("no response") — the dispatcher reconnects the session to a fresh execution. Because the conversation is persisted (via the provider's own resume identifier), the reconnected execution resumes the same logical session rather than starting a new one. This framing generalizes to shared hosting (reconnect to the client) where "respawn a process" would not.

Ordering is fail-loud FIRST, then reconnect. When an execution goes down, the dispatcher signals the loss up to the app **before** opening a fresh execution: each in-flight turn on that session is failed loudly (the user sees the turn interrupted, the spinner unsticks, any open permission prompt is cleared) and only then is the replacement execution brought up and the mapping updated. Mid-turn work is lost — recovery resumes from the last committed turn boundary, never a silent gap. Repeated reconnect failures back off with increasing delay up to a cap; past the cap the dispatcher stops and the host degrades to the ordinary disconnected state.

## Cache lives on the dispatcher

The model/capability cache belongs on the dispatcher, one level above any execution unit, because the dispatcher **outlives** individual executions — executions come and go per session, the per-host front persists. So the first execution to need the data fetches it, writes it back to the front, and every later execution (even for a different project on the same host) reads it from the front. Cross-project sharing works because cache lifetime is decoupled from execution lifetime, not because executions talk to each other. The cache is cache-aside: the front is a passive store that answers hit or miss but never fetches — the requesting execution fetches on a miss and writes the result back. Every entry carries an age and is expiry-bounded; a coarse time-to-live is intrinsic (any cache entry must define "how old is too old"), which matters because a session freezes its capability list for its lifetime, so without a backstop a stale entry would freeze a session indefinitely.

## Dispatcher lifecycle

The dispatcher is ondemand: spawned lazily by the first session to a host, reused by later sessions, and torn down after the last session closes plus an idle grace window (a reopen within the window reuses the warm front and its hot cache). There is no daemon self-respawn — on a remote nothing supervises the front itself, and by design it dies with its owning app's channel. Its death is therefore not a novel failure mode: it degrades to the existing host-level disconnected state, coarser only in that all of that host's sessions disconnect together. Recovery is the ordinary path — the user retries (or opens a session), which spawns a fresh front. This mirrors the pre-existing per-session crash experience; it is retry-driven, not automatic, on purpose.

## Boundaries

- **Dispatch is always shared per host; execution sharing is a resolved policy.** The front is provider-agnostic and always one per host. Whether a session reuses an execution unit or gets its own is decided from the provider's declared multiplex capability at open time, expressed entirely as the runtime-key function — no global hard-coding, no user-facing toggle.
- **The front stays thin by construction.** It must not load provider or SDK code; provider modules load lazily only in the execution role. A front that eagerly imported providers would carry their weight and crash surface despite never running them.
- **The front relays, it does not process.** Opaque pass-through of the stream is mandatory; the front peeks only what it services locally (health reply, cache lookup) and never parses render primitives.
- **Cache belongs to the front, not the client.** It is the only home that spans executions for every provider, including non-multiplexable ones; a client-level copy is at most redundant, never the source of truth.
- **Reconnect is connection-centric and fail-loud-first.** The session's execution is reconnected (and resumed from persisted state), not respawned; the loss is surfaced before the replacement comes up, so a dropped turn is always visible.
- **Front death is an existing state, not a new blast radius.** It collapses to host-level disconnect and recovers by user retry; there is no daemon supervising the daemon and none is added.
