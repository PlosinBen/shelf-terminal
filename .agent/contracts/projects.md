---
type: contract
title: Projects
related:
  - architecture/projects
  - context/projects
  - context/worktree
  - contracts/persistence-formats
---

# Projects

Renderer project contracts cover the store snapshot, project-level event payloads, listing orders, and persistence shape.

## Store Snapshot

Authoritative source: `src/renderer/store.ts`.

```ts
type StoreSnapshot = {
  projects: readonly ReadonlyProjectRuntime[];
  activeProjectId: string | null;
  activeProjectIndex: number;
  editingProjectId: string | null;
  editingProjectIndex: number | null;
  // other renderer UI state...
}
```

`projects` is a deep readonly view. Normal TypeScript call sites must not mutate returned project objects, nested config objects, the tabs array, or tab objects directly.

`activeProjectIndex` and `editingProjectIndex` are derived compatibility values. Long-lived project identity must use `activeProjectId`, `editingProjectId`, or an explicit project id payload.

## Listing Orders

Authoritative source: `src/renderer/store.ts`.

```ts
function getProjectConfigs(): ProjectConfig[]
function listStableProjectViews(): readonly ReadonlyProjectRuntime[]
```

`getProjectConfigs()` returns cloned mutable configs for persistence and IPC boundaries.

`listStableProjectViews()` returns mounted-view order. It must not mutate or depend on visual order beyond the current set of project identities.

## Project-Level Events

Authoritative source: `src/renderer/events/bus.ts`.

```ts
Events.CLOSE_TAB          // (projectId: string, tabIndex: number)
Events.REMOVE_PROJECT    // (projectId: string)
Events.NEW_TAB           // (projectId: string)
Events.CONNECT_PROJECT   // (projectId: string)
Events.DISCONNECT_PROJECT // (projectId: string)
Events.TOGGLE_SPLIT      // (projectId: string)
Events.CREATE_WORKTREE   // (projectId: string, prefill?)
Events.WORKTREE_CLOSE    // (projectId: string, kind)
Events.NEW_AGENT_TAB     // (projectId: string, provider?)
Events.NEW_WEB_TAB       // (projectId: string, url?)
```

Project ids are opaque `ProjectConfig.id` strings. Events may include tab indices only when the tab index is scoped under the project id.

## Persistence

Project persistence remains `projects.json` as an array of `ProjectConfig`. Reorder changes persisted array order, but stable mounted-view order is renderer-derived and is not persisted.

## Feature-note Directory Binding

Authoritative field: `ProjectConfig.featureNoteDir` in `src/shared/types.ts`.

```ts
interface ProjectConfig {
  featureNoteDir?: string;
}
```

An absent field disables worktree feature-note listing, migration, and restore. A configured value is a trimmed, repo-relative POSIX directory: trailing slashes are removed; absolute paths, backslashes, empty/current-directory segments, and parent traversal are rejected. Resolved directories and note candidates must remain inside the project root.

Main projects may edit or clear the field in Project Settings. Child projects use the same interface and field, but Project Settings renders it read-only. Child creation copies the main project's current value; the child retains that stored snapshot even if the main value later changes or is cleared. Existing project records receive no implicit default or migration.
