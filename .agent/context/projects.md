---
type: context
title: Projects
related:
  - architecture/projects
  - contracts/projects
---

# Projects

## projects#1 — Keep-alive views use stable order  ·  [Decision]

**Decision:** Project visual order and right-side keep-alive view order are separate. Sidebar and persistence follow visual order; mounted terminal/agent/web views render in stable project identity order.

**Reason:** Reordering the project array can make React move existing keyed tab DOM nodes with `insertBefore`. Moving the active project's mounted terminal or webview can repaint, refit, or reload it even though the active project id did not change.

**Do not change casually because:** Reusing visual project order for mounted views reintroduces the asymmetric repaint bug: dragging an inactive project may look fine, while dragging the active project can disturb the visible tab.

### Gotchas

- Active visibility must be computed by project id in the stable view loop. Index-based active checks are only valid in visual-order loops.
- A regression should prove both sides: visual order changes after reorder, stable view order does not.

## projects#2 — Project identity is opaque config id  ·  [Decision]

**Decision:** Renderer project targets that cross component boundaries or outlive the current render tick use `ProjectConfig.id` as an opaque project id.

**Reason:** Project indices are visual positions. Drag reorder, delete, worktree close, and async callbacks can shift indices while a dialog, event, or callback is still alive.

**Do not change casually because:** Storing project indices in long-lived UI state can apply edits, remove actions, worktree lifecycle actions, or new-tab actions to the wrong project after reorder/delete.

### Gotchas

- Tab indices may remain scoped under a current project lookup. The risky target is the project identity, not short-lived tab position inside an already resolved project.
- Render-map indices are acceptable for display, drag math, and immediate conversion to project id.

## projects#3 — Array-backed boundary with readonly views  ·  [Decision]

**Decision:** The renderer project collection remains array-backed internally, but callers receive readonly project snapshot views and write through named store/repository actions.

**Reason:** Array internals preserve the existing worktree grouping and persistence behavior while the boundary removes external dependence on raw collection shape. Type-only readonly catches normal accidental mutation of returned projects, configs, tabs, and tab objects during typecheck without clone/freeze churn in render paths.

**Do not change casually because:** Runtime deep-freeze or clone-on-read can disturb object identity and renderer performance. A full `byId + order` internal migration is reserved for present-tense evidence that array internals are creating real complexity, such as repeated order synchronization or another ordering feature.
