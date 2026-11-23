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
  readonly worktreeState?: WorktreeState | null;
  readonly agentViews: Readonly<Record<string, ReadonlyDeep<AgentViewConfig>>>;
}
```

`AgentViewConfig` is `{ provider: string; prefs: Readonly<AgentPrefs> }`, keyed by stable Shelf session id. `ProjectCreateInput` excludes `id` and `agentViews`; main allocates records for Agent startup drafts. Project and new session ids are main-owned.

`worktreeState` is scan-owned metadata defined in `src/shared/worktree.ts`: `{ availability: 'valid' | 'missing', identity: { checkoutPath, gitDir, commonDir } | null }`. Omitted legacy data or null means unscanned, not missing. Preserve the last identity on absence. Existing scanned branch/state metadata survives stale ordinary project saves; reconciliation is its writer. Renderer runtime `folderInvalid`, tabs and scan warning/busy state are not persisted here.

Unknown provider ids remain valid stored data. Runtime resolves them through the live provider registry; the codec preserves records even when no startup tab references them.

`defaultTabs` is the sole connect-time startup source. Its non-empty ordered list contains Terminal, Web, and Agent templates. Canonical Agent rows include `provider` and `sessionId`; the provider must match `agentViews[sessionId]`. Multiple rows may use the same provider, but not the same session. Create/editor drafts may omit sessionId; main materializes a fresh record atomically. Changing a row's provider creates a fresh session, never reuses incompatible context. Connect creates valid templates in order without an implicit fallback. New-project creation materializes one plain Terminal only when the field is omitted.

Worktree creation independently selects an optional Agent provider and Terminal (enabled by default). Child `defaultTabs` contains exactly that selection, Agent first when both are selected. Main allocates fresh Agent identity. Optional create-only `worktreeAgentSourceSessionId` names a View in `parentProjectId`; main requires exactly one new Agent of the same provider and copies the latest persisted source prefs atomically into that new record. Missing/stale/mismatched sources reject creation. The source field is not persisted; parent startup/runtime tabs, session identity and conversation context are not copied. With no source, prefs remain empty. An empty selection is rejected before Git creation; worktree discovery without explicit startup options retains one Terminal. These startup options are creation inputs, not new persisted Project fields.

## Main repository

Authoritative source: `src/main/projects/projects-repository.ts`.

```ts
interface MainProjectsRepository {
  getAll(): readonly Project[];
  get(projectId: ProjectId): Project | null;
  add(input: ProjectCreateInput): Promise<Project>;
  save(project: Project): Promise<void>;
  mutate(projectId: ProjectId, mutation: ProjectMutation): Promise<ProjectMutationResult>;
  delete(projectId: ProjectId, expectedProjectIds?: readonly ProjectId[]): Promise<ProjectDeleteResult>;
  retryCleanup(projectId: ProjectId): Promise<ProjectDeleteResult>;
  reorder(sourceId: ProjectId, targetId: ProjectId): Promise<void>;
}

interface ProjectDeleteResult {
  readonly cleanupPending: boolean;
  readonly leftover?: {
    readonly targetPath: string;
    readonly reason: string;
  };
}
```

`reconcileWorktrees(baseline, updates, additions, isCurrent?, stagedOrphans?)` is an internal main-repository batch operation returning the committed collection or null for a stale baseline. It serializes with add/save/delete/reorder, merges only scan metadata into current projects, inherits current parent setup for additions, and persists once before publication. Its baseline compares topology rather than mutable preferences/session ids. It is not a renderer-supplied replace-all operation.

The repository is exposed only after synchronous bootstrap loading succeeds. It has no public `load`, `replaceAll`, raw file, or persisted-document operation.

`mutate` is the renderer update boundary. It serializes base lookup, comparison, merge and persistence
with other repository writes. `save(Project)` is a main-only low-level operation, not an IPC entry.
Missing mutation targets and unavailable worktrees reject; no successful missing-target fallback is allowed.
Editor conflicts return `{ ok: false, conflicts }` without committing any submitted field.

Identical save, missing delete, and same-group reorder are successful no-ops. Missing save and stale reorder do not guess replacement targets and leave diagnostic context. A rejected mutation means config was not committed. `delete()` resolves with `cleanupPending: true` when config committed but project-session teardown or target-history cleanup remains; `leftover` identifies the target path and reason. Retry uses the current-process cleanup snapshot through `retryCleanup`, never a second delete or a durable tombstone.

`add()` rejects before persistence when another canonical project has the same effective target. Persisted load and `save()` do not enforce this uniqueness rule, so existing duplicate records remain valid.

Parent deletion removes the parent and its registered descendants in one atomic config write.
Removing a child preserves its parent and siblings. `expectedProjectIds`, when provided, must
match the current removal set inside the serialized mutation; a mismatch rejects before commit.
Renderer supplies the confirmed set and holds each affected project's mutation queue while
staging history and deleting. Confirmation lists affected children and Shelf data cleanup;
parent removal does not delete Git worktrees, branches or working directories. Cleanup attempts
every removed member; `retryCleanup(parentId)` retries only unfinished members, and `leftover`
reports one current target failure while all failures are logged. Existing orphan records are
preserved on load and connect. On explicit Rescan, renderer lists all projects whose registered
parent is absent, obtains confirmation, stages their Agent history, and submits the sorted IDs
and session ownership. Main rechecks this scope, validates the remaining scan, and persists
removals, updates and fresh discoveries together. Post-commit cleanup uses each old project ID;
retrying cleanup does not save the config again.

Before Project deletion, renderer stages an IndexedDB pending-cleanup entry for every Agent record
in every removed project. After durable config deletion, it waits for backend teardown and renderer history writes, then clears history and its pending entry atomically. Retry/Cancel is available; cancelled/failed clears retain durable retry inventory for startup. Main target/storage cleanup retains its separate retry result.

Closing/disconnecting collects a View only when neither Default nor runtime references it. Removing a Default collects an already-closed View after successful save; a still-live View remains until close. Startup applies the same rule to unused canonical records. Collection clears history before forgetting metadata, runs within the per-project update queue, and does not scan unknown history or delete provider-native files. Referenced unknown-provider records remain retained.

Effective target comparison is defined by `src/shared/project-target.ts`:

```ts
interface ProjectTarget {
  readonly connection: Connection;
  readonly cwd: string;
}

projectTargetKey(target: ProjectTarget): string
sameProjectTarget(first: ProjectTarget, second: ProjectTarget): boolean
```

The key contains normalized `cwd` plus local scope, SSH user/host/port, WSL distribution, or Docker container. SSH password and `idleShutdownMinutes` are excluded. Path normalization removes trailing `/` and `\` while preserving roots; it performs no filesystem canonicalization.

## Project operation bridge

Authoritative channels: `src/shared/ipc-channels.ts`; bridge: `src/main/preload.ts`; renderer adapter: `src/renderer/projects-repository-client.ts`.

```ts
project.getAll(): Promise<readonly Project[]>
project.add(input: ProjectCreateInput): Promise<Project>
project.update(projectId: ProjectId, mutation: ProjectMutation): Promise<ProjectMutationResult>
project.delete(projectId: ProjectId, expectedProjectIds?: readonly ProjectId[]): Promise<ProjectDeleteResult>
project.retryCleanup(projectId: ProjectId): Promise<ProjectDeleteResult>
project.reorder(sourceId: ProjectId, targetId: ProjectId): Promise<void>
project.validateDirs(): Promise<ProjectId[]>
```

`validateDirs` takes no renderer collection. Main resolves the current projects from its repository. Worktree operations remain project-scoped services and never accept a persisted document or whole canonical collection.

## Project update mutations

Authoritative types/constants: `src/shared/project-mutations.ts`. Tags are defined by `PROJECT_MUTATION`.

| Kind | Payload | Main behavior |
|---|---|---|
| `EDIT` | `{ edits: [{ field, before, value }] }` | Only fields in `PROJECT_EDIT_FIELDS`; reject the entire edit if any latest field differs from both `before` and `value`. Already-satisfied values succeed. Duplicate/unknown fields reject. |
| `AGENT_REPORT` | `{ sessionId, report }` | Merge confirmed/reported prefs into that existing View only; empty confirmed patches do not pin defaults. |
| `CREATE_AGENT_VIEW` | `{ provider }` | Allocate a fresh session with empty prefs; return `{ ok: true, sessionId }` after persistence. Does not append a Default. |
| `FORGET_AGENT_VIEW` | `{ sessionId }` | Forget collected metadata after history clear; reject a latest Default reference, and succeed idempotently when already absent. This local cleanup remains permitted for unavailable worktrees. App must first establish no live runtime reference and settled teardown. |
| `APPEND_DEFAULT_TAB` | `{ tab }` | Append to latest list; Agent references must match an existing View. Same session already present is a no-op; same provider is allowed. |
| `CLEAR_AGENT_PREF` | `{ sessionId, key, savedValue }` | Delete only that View's matching saved value; preserve other Views and newer values. |

```ts
type ProjectMutationResult = { ok: true; sessionId?: string } | { ok: false; conflicts: readonly ProjectEditField[] };
```

Project Edit captures a baseline on opening and submits only changed fields. Background view refreshes
do not reset its draft. Save freezes the form until completion, closes only after mutation and refresh
succeed, and preserves the draft on error/conflict. A conflict refreshes saved values before offering
explicit Reset Changes; no automatic overwrite or draft replacement occurs. Child feature-note bindings
remain read-only at both editor and main boundaries. There is no edit-lifetime config lock.

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
Events.OPEN_EXISTING_PROJECT // (projectId: ProjectId)
Events.UPDATE_PROJECT    // (projectId: ProjectId, mutation: ProjectMutation, onSettled?)
Events.REORDER_PROJECTS  // (sourceId: ProjectId, targetId: ProjectId)
Events.REMOVE_PROJECT    // (projectId: ProjectId)
Events.CLOSE_TAB         // (projectId: ProjectId, tabIndex: number)
Events.NEW_TAB           // (projectId: ProjectId)
Events.CONNECT_PROJECT   // (projectId: ProjectId)
Events.DISCONNECT_PROJECT // (projectId: ProjectId)
Events.TOGGLE_SPLIT      // (projectId: ProjectId)
Events.CREATE_WORKTREE   // (projectId: ProjectId, prefill?)
Events.WORKTREE_CLOSE    // (projectId: ProjectId, kind)
Events.NEW_AGENT_TAB     // (projectId: ProjectId, provider: AgentProvider)
Events.NEW_WEB_TAB       // (projectId: ProjectId, url?)
```

Components emit these intents. The App-side coordinator is the only renderer owner of the project repository client. Tab indices are allowed only when scoped under an explicit current project id.

`UPDATE_PROJECT` completion returns `ProjectMutationResult` or `{ ok: false, error: string }` after
recovery cancellation. App queues updates per project through their retry/refresh lifecycle so an older
failed report cannot retry after a newer report. Saved-pref recovery shares this order; other projects
are not held by that renderer queue. Main remains the authority for latest-base mutation correctness.

Folder Picker emits `OPEN_EXISTING_PROJECT` for the first effective-target match in current reconciled order and otherwise emits `ADD_PROJECT`. The open-existing handler validates the id, activates the project, and emits `CONNECT_PROJECT` only when `tabs.length === 0`. `ADD_PROJECT` and its optional `onSettled` result contract remain creation-only and unchanged.

Manual Agent creation uses the required-provider `emitNewAgentTab` / `onNewAgentTab` wrappers. The App boundary validates the value against the live registry and refuses missing or invalid input with diagnostic context; it never resolves a provider from project configuration.

## Runtime tab defaults and Quick Commands

`Save to Default` retains label/color and the actual variant: Terminal command, Web URL, or Agent provider plus stable sessionId. It does not copy prefs or allocate a replacement session. Same-session duplicates cannot append or mutate the existing entry. Closing a runtime View does not remove its Default reference; a Default or live runtime reference retains its record/history. Removing a Default in Project Settings does not close a live tab. With neither reference remaining, collection waits for teardown and history writers, clears owned history, then forgets metadata as described above.

Manual Agent creation persists a fresh empty-prefs record, refreshes, and then mounts its runtime tab. It never infers settings from another same-provider View. Main initialization validates Project target, provider/session ownership and exclusive live mounting. Per-exec initialization reads that View's latest prefs.

Quick Command named targets are offered only from Terminal templates. Execution resolves `Current tab` or the first matching named runtime tab and sends PTY input only when that tab is Terminal. Agent, Web, missing, and stale targets are refused before IPC with a project-visible explanation and diagnostic context; stored stale targets remain intact for explicit user repair.

## Feature-note directory binding

Canonical field: `Project.featureNoteDir`.

`null` disables worktree feature-note listing, migration, Finish note preflight, and Abandon note-discard confirmation. A configured value is a normalized repo-relative POSIX directory. Main projects may edit or clear it; child projects expose their copied snapshot as read-only and do not follow later parent edits.
