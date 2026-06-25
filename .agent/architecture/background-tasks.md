---
type: architecture
title: Background Tasks
related:
  - context/background-tasks
  - context/agent-core
  - architecture/agent-turn
---

# Background Tasks

This flow describes how work that the model offloads to run in the background is tracked independently of the foreground conversation. The key idea is two decoupled lanes within one agent session: the foreground turn drives the conversation's busy/idle state and ends when its own reply settles, while a separate task lane carries the lifecycle of each background task and is exempt from that busy/idle state. The task lane feeds task cards that appear, update, and settle on their own clock — and when a task finishes, the agent may pick the conversation back up on its own with an auto-resume reply that is presented as its own, distinct turn.

## Flow

### Foreground turn vs. task lane

```
User message
   │
   ▼
Foreground turn ──────────────► busy state (spinner on)
   │  drives conversation reply
   │  model offloads work ──┐
   │                        │
   ▼                        ▼
Foreground reply        Task lane  (session-level, turn-independent)
settles                     │      • not tagged with any turn
   │                        │      • does NOT touch busy/idle state
   ▼                        │      • intercepted before turn routing
idle state (spinner off)    │
                            ▼
                       Task cards
                       (appear / update / settle on their own clock)
```

- A background task's lifecycle events ride a session-level task lane that is intercepted *before* the turn-routing step. Because these events carry no turn identity and never touch the conversation's busy/idle state, the foreground turn can finish and go idle while its offloaded work is still running.
- Each lifecycle event is forwarded the moment it arrives (start, progress, settle) rather than being held until the turn ends. This both prevents a task that finishes *inside* the foreground turn from being dropped, and lets the cards update live instead of appearing all at once at turn's end.
- A foreground reply settling and a task settling are unrelated events on unrelated clocks: the spinner reflects only the foreground turn (and any pending sends), never the task lane.

### Task cards → settle / dismiss

```
Task lane event ──► Task store (upsert by task identity)
                        │
                        ▼
                   Task card
                        │
          ┌─────────────┼──────────────┐
          │             │              │
    still running   settled        user dismiss
          │         (done/fail/      │
          │          stopped)        ├─ already settled ──► remove locally
          │             │            │
          ▼             ▼            └─ still running ──► request a stop,
   (live updates)   final state            keep "stopping…" until the
                                           lane confirms it settled
                                           (with a fallback timeout)
                        │
                        ▼
                 dismissed identities are tombstoned
                 so a late echo can't resurrect the card
```

- The task store upserts cards by task identity. When a card is dismissed, that identity is tombstoned so a late or out-of-order lane echo cannot recreate it; the tombstone set is reset when the conversation is cleared.
- Dismissing a card branches on state: a settled task is simply removed locally (nothing is still running), while a running task issues a real stop request and keeps the card visible in a "stopping" state until the lane confirms the task reached a terminal state — guarded by a fallback timeout in case the confirmation never arrives.
- There is no host-side enumeration of background tasks; the card list is assembled purely from the accumulated lane events.

### Auto-resume after a task settles

```
Task settles on the task lane
   │
   ▼
Model may continue the conversation on its own
   │
   ▼
Auto-resume reply ──► presented as its own turn
                      (separate from any prior foreground turn)
   │
   ▼
busy state — only when no foreground turn is concurrently running
   │
   ▼
idle state when the auto-resume reply settles
```

- After a background task settles, the model may resume the conversation unprompted. This auto-resume is rendered as its own turn, distinct from the foreground turn that originally launched the work.
- An auto-resume drives the busy state (spinner on through the resume, off when it settles) **only when no foreground turn is concurrently running**. If a foreground turn is in flight, its spinner takes precedence and the auto-resume's status is suppressed so it cannot prematurely clear the foreground's busy indicator.
- Distinguishing an auto-resume from a foreground reply relies on conversation ordering plus a single signal on the lane — there is no back-reference from a settled reply to the message that prompted it. A background task settling does not guarantee an auto-resume (the model may simply say nothing), so the distinction must not assume one will follow.

## Boundaries

Inside this flow:
- The split between the foreground turn (which owns conversation busy/idle state) and the session-level task lane (which is turn-independent and busy-state-exempt).
- How background-task lifecycle events become task cards that appear, update, settle, and can be stopped or dismissed independently of the conversation.
- How a settled task can drive an auto-resume reply, presented as its own turn, and when that auto-resume is allowed to drive the busy state.

Outside this flow:
- How a foreground turn itself is sequenced, corresponds to its reply, and is interrupted — covered by the agent-turn architecture.
- Provider-specific mechanics of offloading and resuming (persistent vs. per-turn drivers, how session resume is persisted across restarts, the exact lane and turn-correspondence rules) — covered by the background-tasks context.
- The broader agent-tab architecture: provider binding, dual-layer persistence, the send queue, and the rule that every send must settle to idle — covered by the agent-core context.
- The rendering primitives the cards are drawn from and the store/event-bus layering on the renderer side — covered by the agent UI concerns.
- Plan/checklist items, which are a read-only concept distinct from these live background tasks despite the surface similarity.
