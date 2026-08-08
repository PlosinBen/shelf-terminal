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

Project contracts cover the canonical domain model, main repository operations, renderer composition, and project-level intents. Authoritative domain types are defined in `src/shared/projects.ts`.

## Canonical model

```ts
interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly cwd: string;
  readonly connection: ReadonlyDeep<Connection>;
  readonly maxTabs: number;
  readonly initScript: string | null;
  readonly envPlain: Readonly<Record<string, string>>;
  readonly defaultTabs: readonly ReadonlyDeep<TabTemplate>[];
  readonly quickCommands: readonly ReadonlyDeep<QuickCommand>[];
  readonly featureNoteDir: string | null;
  readonly parentProjectId: ProjectId | null;
  readonly worktreeBranch: string | null;
  readonly baseBranch: string | null;
  readonly defaultAgentProvider: string | null;
  readonly openAgentOnConnect: boolean;
  readonly agentSessionIds: Readonly<Record<string, string>>;
  readonly agentPrefs: Readonly<Record<string, ReadonlyDeep<AgentPrefs>>>;
}
```

`ProjectCreateInput` is the same create-domain input without `id` or `agentSessionIds`, and with fields that receive canonical defaults marked optional. Project ids are opaque strings created only by the main repository.

Unknown provider ids remain valid stored strings and record keys. Runtime behavior must resolve them through the live provider registry; the config loader/formatter must not discard them.

## Main repository

Authoritative source: `src/main/projects/projects-repository.ts`.

```ts
interface MainProjectsRepository {
  getAll(): readonly Project[];
  get(projectId: ProjectId): Project | null;
  add(input: ProjectCreateInput): Promise<Project>;
  save(project: Project): Promise<void>;
  delete(projectId: ProjectId): Promise<ProjectDeleteResult>;
  retryCleanup(projectId: ProjectId): Promise<ProjectDeleteResult>;
  reorder(sourceId: ProjectId, targetId: ProjectId): Promise<void>;
}

interface ProjectDeleteResult {
  readonly cleanupPending: boolean;
}
```

The repository is exposed only after synchronous bootstrap loading succeeds. It has no public `load`, `replaceAll`, raw file, or persisted-document operation.

Identical save, missing delete, and same-group reorder are successful no-ops. Missing save and stale reorder do not guess replacement targets and leave diagnostic context. A rejected mutation means config was not committed. `delete()` resolves with `cleanupPending: true` when config committed but post-commit cleanup failed; retry uses `retryCleanup`, never a second delete.

## Project operation bridge

Authoritative channels: `src/shared/ipc-channels.ts`; bridge: `src/main/preload.ts`; renderer adapter: `src/renderer/projects-repository-client.ts`.

```ts
project.getAll(): Promise<readonly Project[]>
project.add(input: ProjectCreateInput): Promise<Project>
project.update(project: Project): Promise<void>
project.delete(projectId: ProjectId): Promise<ProjectDeleteResult>
project.retryCleanup(projectId: ProjectId): Promise<ProjectDeleteResult>
project.reorder(sourceId: ProjectId, targetId: ProjectId): Promise<void>
project.validateDirs(): Promise<ProjectId[]>
```

`validateDirs` takes no renderer collection. Main resolves the current projects from its repository. Project secrets and worktree operations remain separate project-scoped services and never accept a persisted document or whole canonical collection.

## Renderer project view

Authoritative source: `src/renderer/store-projects.ts`.

```ts
interface ProjectRuntimeState {
  tabs: Tab[];
  activeTabIndex: number;
  splitTabId: string | null;
  folderInvalid: boolean;
}

type ProjectView = Project & ProjectRuntimeState;
```

Store snapshots expose deep-readonly flat project views. There is no `config` property. `activeProjectIndex` and `editingProjectIndex` are derived compatibility values; long-lived targets use ids. `listStableProjectViews()` returns mounted-view order and never changes visual project order.

## Project-level intents

Authoritative source: `src/renderer/events/bus.ts`.

```ts
Events.ADD_PROJECT       // (input: ProjectCreateInput, onSettled?)
Events.UPDATE_PROJECT    // (projectId: ProjectId, changes: Partial<Omit<Project, 'id'>>)
Events.REORDER_PROJECTS  // (sourceId: ProjectId, targetId: ProjectId)
Events.REMOVE_PROJECT    // (projectId: ProjectId)
Events.CLOSE_TAB         // (projectId: ProjectId, tabIndex: number)
Events.NEW_TAB           // (projectId: ProjectId)
Events.CONNECT_PROJECT   // (projectId: ProjectId)
Events.DISCONNECT_PROJECT // (projectId: ProjectId)
Events.TOGGLE_SPLIT      // (projectId: ProjectId)
Events.CREATE_WORKTREE   // (projectId: ProjectId, prefill?)
Events.WORKTREE_CLOSE    // (projectId: ProjectId, kind)
Events.NEW_AGENT_TAB     // (projectId: ProjectId, provider?)
Events.NEW_WEB_TAB       // (projectId: ProjectId, url?)
```

Components emit these intents. The App-side coordinator is the only renderer owner of the project repository client. Tab indices are allowed only when scoped under an explicit current project id.

## Feature-note directory binding

Canonical field: `Project.featureNoteDir`.

`null` disables worktree feature-note listing, migration, and restore. A configured value is a normalized repo-relative POSIX directory. Main projects may edit or clear it; child projects expose their copied snapshot as read-only and do not follow later parent edits.
