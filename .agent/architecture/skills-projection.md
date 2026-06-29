---
type: architecture
title: Skills Projection
related:
  - context/skills
  - context/deployment
  - context/connection-health
---

# Skills Projection

This flow describes how an app-level skill edited in the UI reaches an agent that is already running. At the abstract level there is a single source of truth held by the client and a set of derived, disposable copies — one per app, per machine — that each running agent actually consumes. An edit fans out from the source: the projection is rebuilt, pushed to wherever each agent lives, the provider is asked to reload it in place, and the projection's place is held by a renewing lease so cleanup never reclaims a copy that a live agent still depends on.

## Flow

```
UI skill edit (create / update)
        │
        ▼
   The skill store  ◄── the single source of truth, on the client
        │
        ▼
   One change notification (every edit path converges here)
        │
        ├──────────────► The local projection
        │                   (rebuild the per-app consumption path on this machine)
        │
        ├──────────────► The remote projection (per connection)
        │                   change-hash gate: push only when the copy differs
        │                   from what the far side last received
        │                   │
        │                   ▼
        │                The per-app consumption path on the agent's host
        │
        └──────────────► The renderer (so the UI reflects the new state)

   After each copy lands:
        │
        ▼
   Touch the heartbeat lease for this app's copy
        │
        ▼
   Ask the provider to hot-reload (per live session)
        │  local: reload immediately
        │  remote: re-push first; only reload if the push succeeded
        ▼
   The provider re-scans the per-app consumption path in place
        │
        ▼
   Active sessions pick up the new skill on their next turn
   (no reconnect, conversation history preserved)
```

- The skill store is the only authoritative copy. Everything downstream is a derived projection that can be discarded and rebuilt; an edit never mutates a consumption path directly.
- Every edit path — whether a person editing in the UI or an agent editing through the in-process bridge — converges on one change notification. The triggering site only writes to the store and announces the change; the fan-out (re-project, re-mirror, reload, notify the renderer) is owned downstream, so no caller carries projection logic.
- This fan-out is for *content* edits. Locking or unlocking a skill is not a content edit — the skill's bytes are unchanged — so it never enters this flow; it only repaints the renderer. The lock is enforced at the source and never read from a projection, so there is nothing to re-project, re-mirror, or reload, and the lock marker is itself excluded from the projection and the content hash, leaving every derived copy (and the change-hash gate) invariant.
- The local and remote projections differ only by transport. Both target the same per-app consumption path, addressed identically regardless of where the agent runs. The remote path is gated by a content hash so an unchanged skill is never re-pushed.
- A projection is a whole-package replacement: the consumption path is replaced wholesale, so deletes and renames are covered for free and no migration step is needed.
- The provider loads skills once when a persistent session is first established. Hot-reload is what makes a mid-session edit visible without a reconnect — reconnecting would not help, because sessions are shared across projects and a resumed session reattaches the old snapshot rather than re-scanning.
- Hot-reload is best-effort: with no live session it is a no-op; on the remote side the re-push must succeed before the reload, otherwise the agent would reload a stale copy.
- The heartbeat lease keeps the projection alive. Each live agent renews the lease on its app's copy every heartbeat; an agent's startup cleanup pass reclaims app copies whose lease has gone stale. Because the startup sweep can run before the first heartbeat, the projection step itself renews the lease at the moment it lands — the act of projecting is treated as a liveness signal — so a freshly pushed copy is never mistaken for an orphan and reclaimed.

## Boundaries

Inside this flow:
- The path from a UI skill edit, through the single source of truth, into the per-app consumption path on each agent's host, and finally into active sessions via in-place hot-reload.
- The convergence of every edit path onto one change notification, and the downstream fan-out to local projection, remote projection, renderer, and reload.
- The lease that holds a projection in place against background reclamation, including why projecting must itself renew the lease.

Outside this flow:
- The on-disk layout of a skill, what counts as its identity, and the rules for validating and renaming it — covered by the skills context.
- The wider deployment taxonomy (what is shared across apps versus held per app, how versioned payloads are deduplicated) and the underlying transports that move bytes to a remote host — covered by the deployment context.
- The heartbeat mechanism itself, the reclamation timing and thresholds, and the connection-health states it also drives — covered by the connection-health context.
- How an agent is permitted to edit skills on its own, the read/write permission split, and the per-skill lock that stops an agent from touching a copy — that is the bridge concern within the skills context, not the projection path.
- How the provider exposes which skills a session has loaded for display — a separate read-only concern, not part of the edit-to-live path.
