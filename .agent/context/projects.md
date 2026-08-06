---
type: context
title: Projects
related:
  - architecture/projects
  - contracts/projects
---

# Projects

## projects#1 — Keep-alive views have stable project and tab identity  ·  [Decision]

**Decision:** Project visual order and right-side keep-alive view order are separate. Sidebar and persistence follow visual order; mounted terminal/agent/web views render in stable project identity order. The mounted-view tree identifies each outer project group by project id and each tab by tab id.

**Reason:** Stable sorting prevents visual reorder from moving mounted views, but it does not establish identity by itself. Tab keys inside an unkeyed nested project array are scoped to that array position; inserting or removing an earlier project changes the positional path and makes React remount otherwise unchanged tabs. An agent remount can re-run initialization, while terminal/web remounts can repaint, refit, or reload.

**Do not change casually because:** Reusing visual project order or removing the outer project identity lets unrelated project-list mutations disturb live tabs. A project-level key is required even when every tab already has its own key.

### Gotchas

- Active visibility must be computed by project id in the stable view loop. Index-based active checks are only valid in visual-order loops.
- Regressions must cover both reorder and insertion/removal before a live project. The original mounted tab node must remain the same node; checking only the resulting order misses remounts.

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

## projects#4 — Connected-only sidebar is a non-destructive projection  ·  [Decision]

**Decision:** The connected-only Sidebar mode is transient renderer view state derived from runtime tab presence (`tabs.length > 0`). A contiguous worktree parent/child visual group uses OR semantics: one connected member keeps the whole group visible. Filtering preserves the real project order and active project id; previous/next project actions search the nearest visible real index in their direction without wrapping.

**Reason:** The filter should reduce Sidebar noise without changing project truth or unexpectedly switching the user's working context. Group-level visibility preserves the parent/child visual structure, while visible-only navigation keeps keyboard movement consistent with what the Sidebar shows.

**Do not change casually because:** Rendering or navigating a separately filtered array makes visual indices diverge from index-based project actions. Automatically selecting another project when the active row becomes hidden changes the right-side context as a side effect of display filtering; navigating through hidden rows defeats the filter's purpose.

### Gotchas

- Connection health is not the connectivity source for this view; a project is connected when it owns at least one runtime tab.
- An orphan worktree child remains its own visual group rather than joining non-contiguous rows by a missing parent id.
- Click, context-menu, drag/drop, and navigation targets must resolve to indices in the original visual project list.

## projects#5 — Sidebar header actions preserve terminal focus  ·  [Decision]

**Decision:** Settings, New Project, and connected-filter buttons stay out of sequential Tab focus and prevent native focus transfer at mouse-down. Keyboard operation uses configurable shortcuts; the connected filter defaults to `mod+\`, while Split Right remains `mod+shift+\`.

**Reason:** Shelf is terminal-first: pointer activation of a header action must not move input focus away from the terminal, while shortcut actions provide the keyboard path without making one button in the header group behave differently from its peers.

**Do not change casually because:** Letting a button focus and blurring it after click still interrupts terminal focus and does not restore the prior focus owner. Loose modifier matching can also make `mod+\` trigger Split Right instead of only toggling the filter.
