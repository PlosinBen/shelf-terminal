---
type: architecture
title: Link opening
related:
  - contracts/external-url-intent
  - context/external-url-intent
---

# Link opening

Direct user clicks carry the original href and owning surface into a main-owned destination router. Project web links return a validated action to the renderer, which creates a visible Web tab in that project or presents an error. Project file links pass through a bounded reader and return inert text for a read-only preview. Unsupported destinations present errors without external fallback.

Explicit external intent enters the existing FIFO decision gate, preserving source identity and Copy/Open/Cancel effects. Login notifications, terminal browser launchers and protected main-window navigation retain this external destination. Agent-requested Web tabs continue through their own per-call approval before tab creation; the user-click router grants no agent authority.
