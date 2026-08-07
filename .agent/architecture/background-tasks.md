---
type: architecture
title: Background Tasks
related:
  - context/background-tasks
  - context/agent-core
  - architecture/agent-execution
---

# Background Tasks

Background work is tracked independently from foreground execution control and conversation content. A task lane feeds cards on its own clock; session content continues into the same linear timeline whether it was prompted directly or produced later by provider auto-resume.

## Flow

```text
user message
    │
    ▼
foreground execution ──────────────► busy state
    │ provider offloads work
    ├─ conversation content ───────► linear timeline
    │
    └─ task lifecycle ─────────────► session task lane ─► task cards
              │                         │
              │                         └─ never controls busy/idle
              ▼
       execution settles ──────────► idle / next queued send

task later settles
    ├─ task update ────────────────► task card settles
    └─ optional auto-resume content ► same linear timeline
```

- Background task events are session-scoped and have no execution id. They are routed before execution lookup and never touch the conversation's busy/idle state.
- Task events are forwarded as they arrive instead of waiting for foreground settlement. A task that starts and finishes quickly is still visible, and cards update live.
- Foreground settlement, task settlement, and later conversation content are independent clocks. None acts as a delivery barrier for the others.
- Provider auto-resume may open its own Shelf execution for status/control, but its renderable content still appends to the same timeline. The UI does not present a separate execution/turn block.

## Task card lifecycle

```text
task event ─► task store (upsert by task id) ─► task card
                                                    │
                         ┌──────────────────────────┴─────────────────────┐
                         ▼                                                ▼
                    settles normally                            user dismisses
                         │                                      │
                         ▼                                      ├─ settled: remove
                    final card                                  └─ running: request stop,
                                                                      wait for confirmation
```

Dismissed task ids are tombstoned so late echoes cannot recreate their cards; clearing the conversation resets those tombstones. Stopping a live task keeps a visible stopping state until the task lane confirms settlement, with a fallback timeout for missing confirmation.

## Boundaries

- The task lane is session-scoped, execution-independent, and busy-state-exempt.
- Task cards and the conversation timeline are separate surfaces; task updates never need ordering relative to content messages.
- Auto-resume content follows ordinary session content rules: arrival-order append for a new message id and in-place upsert for an existing id.
- Execution status may control a spinner and queue release, but never whether auto-resume content is displayed.
- Provider-specific persistent drivers, native turn/cycle mapping, and task normalization live in provider context rather than this abstract flow.
