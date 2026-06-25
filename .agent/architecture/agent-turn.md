---
type: architecture
title: Agent Turn
related:
  - context/agent-core
  - context/agent-ui
  - context/agent-config-flow
---

# Agent Turn

How a typed user message becomes rendered agent output. The path runs through three distinct domains — the renderer (draft, optimistic display, mirrored ordering), the host process (per-turn event routing), and the provider backend (ordering authority, native turn execution). The shaping principle throughout: the renderer owns drafting and display but not control; the backend owns ordering and turn boundaries; what crosses between them is render primitives, never provider vocabulary. A message can also branch off the conversational path into a structured config edit or a picker exchange — both reuse the same turn machinery rather than opening side channels.

## Flow

```
                 user types
                     │
              ┌──────▼───────┐
              │  input zone  │  draft, slash-prefix sniff, attachments
              └──────┬───────┘
                     │ emits a send intent (no side effect here)
              ┌──────▼───────┐
              │  event bus   │  decouples trigger from effect
              └──────┬───────┘
                     │
        ┌────────────▼─────────────┐
        │  central effect handler  │  the one place that touches the host
        │  - append optimistic     │     and writes state
        │    user entry to store   │
        │  - eager-send each msg   │
        │    with a client-minted  │
        │    correlation id        │
        └────────────┬─────────────┘
                     │ cross-process channel (the wire)
                     │
   ══════════════════╪════════════════════  process boundary
                     │
        ┌────────────▼─────────────┐
        │   provider backend       │
        │  ┌────────────────────┐  │
        │  │  the send queue    │  │  ORDERING AUTHORITY:
        │  │  (server-owned)    │  │  serializes turns, emits an
        │  └────────┬───────────┘  │  ordered snapshot on every change
        │           │              │
        │           │ snapshot: each queued/running item ──┐
        │           │              │                       │
        │  ┌────────▼───────────┐  │                       │
        │  │  provider turn     │  │  native SDK query;     │
        │  │  (native backend)  │  │  config edits and      │
        │  └────────┬───────────┘  │  picker requests       │
        │           │              │  branch from here      │
        │           │ render primitives + state side-channels
        └───────────┼──────────────┘                       │
                    │                                       │
   ═════════════════╪═══════════════════  process boundary │
                    │                                       │
        ┌───────────▼──────────────┐                        │
        │   per-turn router        │  routes each event by  │
        │   (host process)         │  its turn id to that   │
        └───────────┬──────────────┘  turn's reader; stray  │
                    │                  ids are dropped+logged│
        ┌───────────▼──────────────┐                        │
        │   per-tab message store  │ ◄──────────────────────┘
        │   - upsert by message id │   queue snapshot reconciled here:
        │   - reconcile snapshot:  │   queued → chip, running → promote
        │     promote / drop / keep│   optimistic entry to real bubble
        │   - plan side-channel    │
        └───────────┬──────────────┘
                    │ subscribe
        ┌───────────▼──────────────┐
        │   renderer timeline      │  pure render of primitives;
        │   + plan panel + status  │  no provider-shaped branching
        └──────────────────────────┘
```

The conversational spine: a keystroke becomes a draft in the input zone, which on submit emits a send intent onto the event bus and performs no side effect itself. A single central handler receives the intent, writes an optimistic user entry into the per-tab store (instant echo), and eager-sends the message across the wire stamped with a client-minted correlation id — it does not hold or batch. The provider backend's send queue is the sole ordering authority: it serializes overlapping turns and, on every change, emits a complete ordered snapshot of what is queued versus running. The renderer mirrors that snapshot rather than guessing turn boundaries — queued items draw as chips, and when an item flips to running the optimistic entry is promoted into a real timeline bubble. Each turn then runs as a native provider query; its output crosses back as render primitives (an inline reply, a foldable card, a note, a system divider, an error) carried on a per-turn envelope. A per-turn router in the host process fans these events to the reader for that turn by id and drops anything whose turn is already gone. The store upserts by message id; the timeline subscribes and renders primitives only.

Two branches leave this spine without leaving the machinery:

- **Config edits** (model / effort / permission, whether typed as a slash with arguments, chosen from a picker, or clicked in the status bar) flow as a structured config-edit turn — same send path, same turn lifecycle — to the provider, which applies the change against its SDK and re-broadcasts its capabilities. Display and persistence follow that broadcast; the renderer never optimistically simulates the new value.
- **Picker requests** originate from the provider mid-turn (a structured multi-question form). The renderer presents the form and returns index-aligned answers (or a cancellation) back through the turn, which the provider feeds to the model to continue.

A state side-channel runs parallel to the timeline: the plan/todo view is replace-semantics state, not an appendable event, so it bypasses the message store's timeline entirely and overwrites a dedicated slice.

## Boundaries

- **Renderer owns drafting and display; the backend owns ordering and turn boundaries.** The client eager-sends and mirrors the server's ordered snapshot — it never decides when a turn starts or ends, and never re-derives the queue locally.
- **The wire carries render primitives, not provider semantics.** What crosses to the renderer is shaped for rendering (reply / foldable card / note / system / error); the renderer holds no provider type, tool name, or slash grammar and adds no "if this tool then…" branch.
- **Every send must terminate in an idle signal on its own turn id.** The renderer flips to streaming the instant a message is sent and waits for idle to release; any early-out or error path that skips idle wedges the spinner permanently. Each dropped or cancelled send still emits a terminal idle on its turn id.
- **Correlation ids and turn ids stay internal.** The client-minted send id exists only to reconcile the optimistic entry against the server snapshot; the per-turn id exists only to route events and key store upserts. Neither leaks into UI behavior decisions.
- **Config flows one way per concern.** The renderer holds preferences and sends edits imperatively; the backend holds confirmed status and capabilities and broadcasts them. Disk persists only what the backend has confirmed — rejected values never broadcast, so they never persist.
- **The trigger never performs the effect.** UI elements and keybindings only emit intents; the host-touching side effects (send, append, persist) are centralized in one handler, keeping siblings indirectly coupled through the store rather than directly wired.
- **Plan/todo state is not timeline.** It is replace-semantics state on its own channel and slice, deliberately kept out of the appendable message history.
