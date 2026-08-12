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
user input
    │ send intent + client message id
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

The client eager-sends each input and mirrors the backend's ordered queue snapshots. A queued item appears as a chip; when it becomes running, its optimistic user message is promoted into the timeline. The client does not infer provider boundaries or decide when another send may start.

Provider output divides into two independent lanes:

- **Content lane:** render primitives are session-scoped. A new message id appends at arrival position; a repeated message id updates that existing entry in place. Content remains deliverable before, during, or after execution settlement.
- **Control lane:** status and permission events are addressed by execution id. Streaming/idle controls busy state, permission cleanup, reader completion, and release of the next queued send. Settlement never closes or drains the content lane.
- **Session-state lane:** authoritative capabilities/config updates belong to the session. They may be emitted by an explicit edit or by a provider notification with no active execution, and remain deliverable through the session sink.

The renderer is the sole owner of streamed-text accumulation and persistence. An active execution may give the newest stream segment a caret. When the execution becomes idle, current partial content is settled and persisted. If a later content chunk arrives, it is appended or upserted normally, remains visually settled, and is persisted immediately; it does not reactivate execution state.

The timeline renders all user, assistant, system, note, error, and fold entries directly in store order. It does not reconstruct provider or protocol turns. Tool-child placement is the only hierarchy: a message with a matching parent tool id may nest under that earlier tool card, while a missing parent remains visible at top level.

Plan/todo data is not timeline content. It is replace-semantics state on its own side channel and panel.

## Boundaries

- **Execution is a control concept, not an ACP turn.** `executionId` names Shelf's local lifecycle reader for one accepted send or provider-initiated execution. It is not a claim about a provider protocol's turn identity and must not be used as a content ownership key.
- **Content and settlement are independent.** An idle or stop reason may release the queue and clear permission state, but cannot decide that all content has arrived. No grace timer, drain barrier, “current prompt,” or “last prompt” attribution is allowed on the content path.
- **Arrival order is presentation order.** New message ids append when received. Existing message ids are upserted in place so streaming deltas and final forms remain one timeline entry.
- **The renderer timeline has no execution boundary.** Message visibility, DOM grouping, spacing, and insertion never depend on execution id or a derived start marker.
- **The wire carries render primitives, not provider vocabulary.** Provider-specific update shapes are translated before crossing into renderer-facing state.
- **Every accepted send terminates its control reader.** Success, failure, cancellation, or queue removal must produce terminal control settlement so busy state and queued work cannot remain locked.
- **Permission correlation is execution-local.** Tool permission requests use the active execution's response channel and tool-use id; this permission pointer is not a general content sink.
- **The backend owns ordering.** The renderer submits eagerly and mirrors authoritative queue snapshots instead of guessing execution seams.
- **Config confirmation flows one way.** The renderer sends edits; the backend publishes confirmed capabilities/status. Shelf-strategy state may persist after confirmation; provider-native permission descriptors remain session-scoped and replace from provider truth.
- **Triggers emit intents.** Host-touching effects and store mutation stay centralized rather than being performed by UI triggers.
