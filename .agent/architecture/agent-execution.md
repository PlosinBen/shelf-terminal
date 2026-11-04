---
type: architecture
title: Agent Execution and Content Flow
related:
  - context/agent-core
  - context/agent-ui
  - context/agent-config-flow
  - contracts/agent-wire-protocol
---

# Agent Execution and Content Flow

How a typed message becomes rendered output while conversation content remains independent from execution settlement. The renderer owns drafting, the flat timeline, and message accumulation; the backend owns send ordering and provider execution; the host routes session content separately from execution control.

## Flow

```text
input Caller
    │ original content + source + attachments + reply requirement
    ▼
message factory ── structure validation + message identity
    │ common message
    ▼
entry trust boundary ── validate without replacing identity
    │
    ▼
central effect handler ── optimistic user message ───────────────┐
    │                                                           │
    ▼                                                           │
backend send queue ── authoritative queued/running snapshots ───┤
    │ serializes provider work                                  │
    ▼                                                           │
provider execution                                              │
    ├─ content: message / stream / error ── session sink ───────┤
    ├─ session state: capabilities ───────── session sink ──────┤
    └─ control: status / permission ─────── execution reader     │
                                                   │             │
                                                   └─ idle releases the next queued send
                                                                  │
                                                                  ▼
                                                        per-tab message store
                                                                  │
                                                                  ▼
                                                        one linear timeline
```

Session readiness also carries a confirmed-configuration loop:

```text
durable selections for the View's stable session
    │ desired initialization intent (empty for a new View)
    ▼
restore provider session ── missing-context recovery ── create replacement session
    │
    ▼
hydrate advertised controls → apply saved selections → assemble final capabilities
                                                             │ confirmed values
                                                             ▼
                                                    durable project selections
```

Session restore or replacement is completed before saved selections are applied. A provider whose session requires imperative initialization sends each saved, advertised selection after establishing the final session, even when the restored value already matches. Capability publication stays covered during init apply, so the renderer sees one final authoritative snapshot rather than persisting intermediate provider defaults. A rejected or unconfirmed selection fails initialization and publishes no replacement capability snapshot. Reusing an initialized live session for a later capabilities read does not repeat the session's init apply.

An explicit conversation reset uses the same initialization boundary:

```text
clear command
    │
    ▼
provider command boundary ── capture confirmed session selections
    │
    ▼
replacement coordinator
    ├─ invalidate persisted conversation pointer + session context usage
    ├─ reset provider-owned session state
    ├─ establish replacement session
    └─ initialize from captured selections
             │
             ├─ bare clear: confirm + settle
             └─ trailing input: first prompt on replacement session
```

The coordinator owns transaction order but treats captured state and replacement operations as opaque callbacks. The provider owns command recognition, concrete session fields, protocol operations, configuration confirmation, and optional prompt dispatch. A failed step terminates the execution visibly and cannot dispatch input to the invalidated conversation.

The client eager-sends each input and mirrors the backend's ordered queue snapshots. A queued item appears as a chip; when it becomes running, its optimistic user message is promoted into the timeline. The client does not infer provider boundaries or decide when another send may start.

Callers own input-context decisions; the factory owns message construction and identity. The Sender
coordinates validation, target lookup and execution without source-specific prompt assembly.
Message content and reply requirements remain separate. Providers recognize original commands before
shared reply guidance prepares model input; protocol translation remains provider-owned. Target and
execution configuration stay outside the message. User history retains optional canonical metadata
without replacing the existing timeline or queue projection. Internal callers keep their existing
direct user-message mirror. No new acceptance or retry protocol is implied by the common message.

Session initialization restores provider context before capability discovery may create a replacement context. A restore operation may replay provider history; when the client already owns the persisted timeline, replay render content is hydration input rather than new timeline content, while restored configuration and command metadata still update session state. A newly created provider context becomes durable immediately, before the first execution can reuse it.

Provider output divides into two independent lanes:

- **Content lane:** render primitives are session-scoped. A new message id appends at arrival position; a repeated message id updates that existing entry in place. Content remains deliverable before, during, or after execution settlement.
- **Control lane:** status and permission events are addressed by execution id. Streaming/idle controls busy state, permission cleanup, reader completion, and release of the next queued send. Settlement never closes or drains the content lane.
- **Session-state lane:** authoritative capabilities/config updates belong to the session. They may be emitted by an explicit edit or by a provider notification with no active execution, and remain deliverable through the session sink.

The renderer is the sole owner of streamed-text accumulation and persistence. An active execution may give the newest stream segment a caret. When the execution becomes idle, current partial content is settled and persisted. If a later content chunk arrives, it is appended or upserted normally, remains visually settled, and is persisted immediately; it does not reactivate execution state.

The timeline renders all user, assistant, system, note, error, and fold entries directly in store order. It does not reconstruct provider or protocol turns. Tool-child placement is the only hierarchy: a message with a matching parent tool id may nest under that earlier tool card, while a missing parent remains visible at top level.

Plan/todo data is not timeline content. It is replace-semantics state on its own side channel and panel.

## Worktree delegation

The initiating Agent requests target selection; the host presents open worktree Views to
the user and returns the selected identity within the same request. Selection authorizes
a specific pair. Starting the collaboration locks its recipient View; the host owns this
memory-only relationship independently of provider execution.

Work messages follow the common message factory and existing send queue. Queue receipt
releases the initiating tool while execution continues independently. The recipient
explicitly updates UI progress or submits a single text result. Arrival does not enter
the initiating conversation. User collection sends the result through the common input
path, retaining the relationship for the next dependent experiment.

Intervention permits human conversation and rejects new initiating-agent work without
stopping execution. UI projections do not own authorization. Explicit stop or View
closure ends the relationship, not the other Agent's execution. Uncollected results
require discard confirmation. Temporary backend interruption is not logical View
closure. No collaboration history or restart recovery is maintained.

## Boundaries

- **Configuration is not part of ordinary input.** Each new execution process completes initialization from current durable project selections before delivering input. Concurrent callers share the pending initialization, not a settings cache. Idle wake, authentication reconnect, and automatic process replacement invalidate the old initialization identity. Explicit edits retain the same ordered execution queue; protocol-specific application and confirmation stay inside the provider.
- **Shelf tool semantics are provider-neutral.** Tool names, descriptions, input schemas, and main-operation mappings are shared contracts. Provider or protocol adapters own registration, validation integration, and result envelopes. Shared protocol handling belongs to that protocol layer; a host serving multiple protocols' consumers does not belong to one consumer's adapter.
- **Execution is a control concept, not an ACP turn.** `executionId` names Shelf's local lifecycle reader for one accepted send or provider-initiated execution. It is not a claim about a provider protocol's turn identity and must not be used as a content ownership key.
- **Content and settlement are independent.** An idle or stop reason may release the queue and clear permission state, but cannot decide that all content has arrived. No grace timer, drain barrier, “current prompt,” or “last prompt” attribution is allowed on the content path.
- **Arrival order is presentation order.** New message ids append when received. Existing message ids are upserted in place so streaming deltas and final forms remain one timeline entry.
- **The renderer timeline has no execution boundary.** Message visibility, DOM grouping, spacing, and insertion never depend on execution id or a derived start marker.
- **The wire carries render primitives, not provider vocabulary.** Provider-specific update shapes are translated before crossing into renderer-facing state.
- **Every accepted send terminates its control reader.** Success, failure, cancellation, or queue removal must produce terminal control settlement so busy state and queued work cannot remain locked.
- **Permission correlation is execution-local.** Tool permission requests use the active execution's response channel and tool-use id; this permission pointer is not a general content sink.
- **The backend owns ordering.** The renderer submits eagerly and mirrors authoritative queue snapshots instead of guessing execution seams.
- **Config confirmation flows one way.** The renderer sends edits or initialization intent; the backend applies them and publishes confirmed capabilities. Providers can publish an explicit confirmed-preference patch separately from effective values. When present, only that patch persists; empty patches display defaults without pinning them. Providers without the patch retain snapshot-driven persistence. Native controls include mode, permission, and approval. Provider snapshots remain runtime truth, and failed edits or initialization never write preferences.
- **Session identity and project configuration are separate lifecycles.** Replacing a missing provider session may discard provider conversation context, but it must not discard durable project selections. Recovery notices and session-pointer persistence remain independent from configuration initialization.
- **Clear replaces conversation state, not its process or project.** A provider may emulate clear by replacing its session on the existing connection. The resulting initialized empty session follows the same persistence and reconnect behavior as an AgentView before its first prompt.
- **Session and account usage have different lifetimes.** Invalidating a conversation explicitly clears its context-usage value, while account quota remains unchanged. Absence of new usage data cannot be represented as a synthetic zero.
- **Usage observation precedes display integration.** A provider may intercept newly available session usage for bounded diagnostics before translation into renderer state. Session/prompt markers establish the observation window even before an output sink is bound or after prompt settlement. Such diagnostics do not change execution control, account quota, or other providers' usage handling.
- **Restore failure does not imply fresh context.** Authentication, transport, unsupported-method, timeout, and malformed restore failures terminate initialization unless a provider has a separately proven missing-context recovery rule.
- **Triggers emit intents.** Host-touching effects and store mutation stay centralized rather than being performed by UI triggers.


## Invalid saved configuration recovery

A provider identifies an invalid saved field and returns typed recovery metadata with failed initialization. The renderer displays Retry and an explicit field-clearing action. The App coordinator compares the current saved value, saves only that deletion, refreshes authoritative project state, and reinitializes the same agent session. Other settings and providers retain their values. Query/auth failures do not imply invalid prefs and do not authorize deletion. Recovery uses the existing session lifecycle rather than a separate reset protocol.

## Exit persistence

Normal exit intent passes through a correlated preparation request before any destructive shutdown.
The renderer waits for submitted project operations and history writes, then persists owned conversation
snapshots, including received partial content marked as interrupted. Snapshotting does not settle the
running execution. Failed batches remain retryable independently of the in-memory display window.

Preparation success permits host shutdown. Failure or cancellation retains the live Views; only explicit
user approval after an unresponsive renderer may bypass confirmed persistence. Retried and cancelled
attempts have separate identities, so an obsolete result cannot authorize exit. Conversation ownership,
explicit history clearing and teardown settlement also govern exit writes; the snapshot cannot revive
collected data. This flow does not restart unfinished executions or persist other editor drafts.
