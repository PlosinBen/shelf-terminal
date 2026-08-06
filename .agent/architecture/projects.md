---
type: architecture
title: Projects
related:
  - context/projects
  - contracts/projects
---

# Projects

Projects are renderer-local runtime state backed by a persisted project-config list. The collection boundary owns project identity lookup, visual ordering, stable mounted-view ordering, and config persistence. UI state owns which project is active or being edited by id.

## Flow

```text
Persisted project configs
  -> project collection boundary
  -> visual project order -> sidebar / persistence
  -> stable project view order -> mounted terminal / agent / web views

Visual project order + runtime tab presence + transient filter mode
  -> visual-group connectivity
  -> visible real project indices
  -> sidebar rows / directional project navigation

User project action
  -> project id event or store action
  -> collection boundary resolves current project
  -> runtime/config mutation
  -> readonly snapshot to renderer

Project-owned request
  -> resolve source project identity
  -> focus source project
  -> render request gate with the source's visible label
  -> continue or deny within that project
```

## Boundaries

The project collection boundary owns project lookup, add/delete/reorder, config update, visual listing, stable mounted-view listing, and persistence writes for project config/order changes.

Renderer view state owns active project id, editing project id, sidebar/panel visibility, and invalid-id reconciliation after deletion.

Sidebar visibility is a projection over visual project order, not a second project collection. It may hide the active project row without changing the active project or mounted right-side view; interactions continue to target real visual indices.

An app-global gate with a project owner must resolve and focus that owner before it is presented.
Unknown ownership fails closed; a completed or cancelled gate leaves the source project active rather
than maintaining a navigation-return stack.

Project runtime state includes tabs, active tab index, split tab id, folder validity, and connection health. Persistence serializes only project config; runtime tab/session state stays renderer-local.

## Ordering

Visual order is the user-facing project list order. It is group-aware for worktree parent/child rows and is the order persisted to disk.

Stable mounted-view order is deterministic by project identity and does not change when visual order changes. Mounted-view identity is hierarchical: project identity owns a tab subtree, and tab identity owns the individual view. Reorder, insertion, or removal preserves every unaffected subtree instead of remounting it.
