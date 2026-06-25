---
type: architecture
title: PM Control
related:
  - context/pm-agent
---

# PM Control

The PM agent is a background supervisor that observes projects and drives the command-line agents running inside their terminals. It is reactive: it wakes on an inbound message, runs one reasoning turn with the relevant project context, and its only lever on the world is typing into a terminal. Everything it "does" is mediated by the command-line agent already living in that terminal — the PM never touches the file system, runs no commands of its own, and cannot escalate beyond writing characters into a session. This document describes how a message becomes an effect, how that effect is observed back, and where the boundaries of the loop sit.

## Flow

```
                inbound message
       ┌─────────────────────────────┐
       │                             │
 the chat bridge                 the in-app panel
 (remote, mobile)                (read-only view)
       │                             │
       └──────────────┬──────────────┘
                      ▼
              the single thread
        (one unbounded conversation;
         both surfaces are views of it,
         deduped and ordered)
                      │
                      ▼
              the PM turn ──────────────► reads ──┐
        (reasoning over conversation                │
         history + injected per-turn                ▼
         focus + the project context)        the project context
                      │                      (rolling per-project
                      │                       summary the PM keeps)
              mode gate (away/active)                ▲
                      │                              │
            away?     │   active?                    │
       ┌──────────────┴──────────────┐               │
       ▼                             ▼               │
  the terminal channel         observe only          │
  (PM may type into a          (channel withheld;     │
   project's terminal)          the human is driving)  │
       │                                              │
       ▼                                              │
  the command-line agent ───── runs the work ─────────┘
  (inside the terminal;          (edits, commands,
   actually executes)             outcomes)
       │
       ▼
  terminal output ──────────────────────────────────┐
       │                                             │
       ▼                                             ▼
  the scrollback observer                     wake the PM
  (captures recent output                     (new effects or
   per terminal, as text)                      events feed the
                                               next inbound turn)
```

A message arrives from either the chat bridge or the in-app panel and lands in the single shared thread. The PM turn reasons over that thread plus a freshly injected note of what the human is currently focused on, consulting the rolling summary it keeps for the project. The mode gate then decides whether the PM may act: in away mode the terminal channel is exposed and the PM can type into a project's terminal; in active mode the channel is withheld and the PM observes only, because the human is at the keyboard. When the PM does write, the characters land in a command-line agent running inside that terminal, which performs the real work. The resulting output is captured by the scrollback observer as recent text, which is how the PM perceives outcomes — there is no structured channel back from the worker. New effects or events feed the next turn, closing the loop.

## Boundaries

- **One output channel, nothing else.** The PM's sole effect on the world is typing into a terminal. It has no command, edit, or file-system capability of its own. Destructive actions are gated by the command-line agent's own permission layer, not re-implemented here; a hard red-line guard on the channel refuses a small set of catastrophic patterns regardless of what the PM reasoned.

- **Perception is unstructured.** The PM understands worker state by reading recent terminal output as plain text, not via a typed protocol. This tolerates parse error by design, and means the PM can only supervise a project whose terminal already has a command-line agent running in it.

- **Mode gates authority, globally.** Away versus active is a single global toggle, not per-project or per-task. Active means the human drives and the PM only observes; away means the PM may act. The channel is physically withheld in active mode, so gating is enforced by capability, not by instruction.

- **Focus is per-turn context, not a fixed target.** Each turn the PM is told what the human is currently focused on and defaults its actions there, while retaining the ability to look across projects when a message demands it. Focus is injected as durable context that survives conversation trimming, never folded into the user's message.

- **One thread, two views.** The remote bridge and the in-app surface are not separate conversations; they are two windows onto the same unbounded thread, kept consistent by dedup and ordering. The PM keeps continuous memory regardless of which surface a message came from.

- **Durable principles live outside the conversation.** Operating rules, authorization limits, and red lines are pinned where conversation trimming and clearing cannot reach them, and reinforced each turn against recency drift. The project's rolling summary is the PM's own working memory of a project, size-bounded and rewritten whole each time, not an append-only log and not a place the human edits to leave instructions.
