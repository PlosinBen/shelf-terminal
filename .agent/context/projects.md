---
type: context
title: Projects
related:
  - architecture/projects
  - contracts/projects
  - context/keybindings-shell
---

# Projects

## projects#1 — Keep-alive views have stable project and tab identity  ·  [Decision]

**Decision:** Project visual order and right-side keep-alive view order are separate. Sidebar and persistence follow visual order; mounted terminal/agent/web views render in stable project identity order. The mounted-view tree identifies each outer project group by project id and each tab by tab id.

**Reason:** Stable sorting prevents visual reorder from moving mounted views, but it does not establish identity by itself. Tab keys inside an unkeyed nested project array are scoped to that array position; inserting or removing an earlier project changes the positional path and makes React remount otherwise unchanged tabs. An agent remount can re-run initialization, while terminal/web remounts can repaint, refit, or reload.

**Do not change casually because:** Reusing visual project order or removing the outer project identity lets unrelated project-list mutations disturb live tabs. A project-level key is required even when every tab already has its own key.

### Gotchas

- Active visibility must be computed by project id in the stable view loop. Index-based active checks are only valid in visual-order loops.
- Regressions must cover both reorder and insertion/removal before a live project. The original mounted tab node must remain the same node; checking only the resulting order misses remounts.

## projects#2 — Project identity is an opaque main-owned id  ·  [Decision]

**Decision:** Renderer project targets that cross component boundaries or outlive the current render tick use canonical `Project.id` as an opaque id. New ids are created only by the main project repository; create callers provide id-less input and wait for the returned project.

**Reason:** Project indices are visual positions that shift during reorder/delete, while caller-created ids would distribute identity rules across FolderPicker, worktree, and future entry points. Main ownership keeps uniqueness and lifecycle validation at the create boundary.

**Do not change casually because:** Storing indices in long-lived UI state can target the wrong project; letting callers mint ids creates inconsistent flows and makes worktree continuation run before durable identity exists.

### Gotchas

- Tab indices may remain scoped under a current project lookup. The risky target is the project identity, not short-lived tab position inside an already resolved project.
- Render-map indices are acceptable for display, drag math, and immediate conversion to project id.

## projects#3 — Canonical collection and renderer runtime are separate layers  ·  [Decision]

**Decision:** Main owns a deep-readonly canonical `Project[]`. Renderer stores that canonical collection separately from runtime-by-project-id and composes flat readonly `ProjectView` values. Components read flat fields and write config only by emitting intents handled by the App-owned coordinator.

**Reason:** Persisted schema compatibility, durable mutation, runtime tabs, and React reactivity have different responsibilities. Keeping them separate prevents legacy/default logic from leaking into the store while preserving tabs and active runtime state by stable id across authoritative refreshes.

**Do not change casually because:** Restoring a nested `project.config` view or letting the store/client persist directly recreates the boundary this design removes. Runtime belongs to the store; raw schema and config writes belong to main; the renderer client remains stateless and App-private.

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

## projects#6 — Project documents load through a versioned canonical boundary  ·  [Decision]

**Decision:** Only the main project config persistence boundary sees raw `projects.json`. It distinguishes opaque file access from format conversion, loads supported legacy v0 arrays, v1 envelopes, or current v2 envelopes into the same canonical `Project[]`, and always formats new writes as v2. Load never performs migration writes.

**Reason:** Central conversion prevents parsing, defaults, provider compatibility, and schema guesses from spreading across bootstrap and consumers. Version dispatch makes unsupported future formats deterministic. Delaying write-back until a real project mutation avoids changing user files merely by opening the app.

**Do not change casually because:** Casting parsed JSON to an application type bypasses validation and can publish partial/invalid data. File I/O must not infer JSON semantics, and loader/formatter details must not cross repository or IPC boundaries.

### Gotchas

- Missing file is canonical empty; an existing empty file is malformed input.
- Unknown provider ids are compatibility data and must round-trip even when the live registry cannot execute them.
- A nonempty persisted collection becoming empty is legal, but the original opaque file is backed up before atomic replacement.
- v0/v1 startup fields are decoder-only input. Conversion materializes a non-empty ordered tab list, interprets a non-null legacy provider as an Agent startup row regardless of the old boolean, and removes both legacy fields from the canonical object.

## projects#7 — Durable mutation, refresh, and cleanup have separate recovery semantics  ·  [Decision]

**Decision:** Main publishes a candidate project collection only after atomic persistence succeeds. Renderer mutations then query the authoritative collection and reconcile runtime by id. A pre-commit failure may retry the mutation; a post-commit refresh failure may retry only refresh. Delete storage/secrets cleanup is post-commit and uses `cleanupPending` plus `retryCleanup`.

**Reason:** Durable-first flow keeps renderer/main/disk aligned without optimistic rollback. Separating refresh prevents duplicate add/delete after a command already committed, while separating cleanup avoids claiming a durable config deletion failed merely because residual side data could not be removed.

**Do not change casually because:** Retrying a committed mutation can create duplicate projects or repeat lifecycle effects. Tearing down tabs or IndexedDB before delete commit/reconcile loses runtime state when persistence fails. Re-sending delete for cleanup conflates two different outcomes.

### Gotchas

- Retry/Cancel is user-controlled; repeated refresh failures remain refresh-only until the user cancels.
- Worktree secrets and auto-connect begin only after child add returns its main-owned id and renderer reconcile completes. Secret Retry targets the same child; Cancel leaves that durable child disconnected.
- This is single-renderer, local-file coordination. Do not add global mutation queues, revision conflicts, or file locks without a real second writer.

## projects#8 — Target uniqueness applies only to new project creation  ·  [Decision]

**Decision:** A new project cannot reuse an existing effective target, defined as connection identity plus a lexically normalized `cwd`. Local identity is local-machine scope; SSH identity is user, host, and port; WSL identity is distribution; Docker identity is container. SSH password and idle-shutdown policy do not affect identity. Path normalization removes trailing `/` or `\` separators while preserving roots.

Folder Picker treats a matching selection as reopening the first matching project in current reconciled order. It activates that project and connects it only when the project has no runtime tabs. The main repository independently rejects matching targets at `add` before persistence.

**Reason:** Separate project ids otherwise create independent Shelf state for terminals and agents operating on the same configured files. Renderer preflight fulfills the user's Open Project intent without generic mutation error UX, while the repository guard covers every creation caller and preserves `add` as an unambiguous creation contract.

**Do not change casually because:** Target uniqueness is deliberately add-only and non-retroactive. Persisted load and project save/update must continue accepting existing duplicate records; they are not migrated, merged, deleted, reordered, or repaired. Returning an existing project as a successful `add` would also let creation continuations treat an old project as newly created.

### Gotchas

- Multiple legacy matches resolve to the first project in reconciled order without modifying any record.
- Target comparison is configuration-level and lexical. It does not use filesystem I/O, `realpath`, symlink resolution, case folding, `.` / `..` normalization, or connection aliases.
- The same path on distinct connection identities remains valid. A Git worktree remains distinct because its configured working directory differs.

## projects#9 — Sidebar Project Search locates visible rows without filtering  ·  [Decision]

**Decision:** Project Search opens only from the Sidebar header's magnifying-glass button. It has no app-level shortcut and does not infer search intent from ordinary printable input. The button opens a focused input in a temporary row below the header.

Search runs after the connected-only projection and performs a case-insensitive substring match against exactly the label displayed by each visible row: project name for a main project and branch name for a worktree child. It preserves every projected row, its order, and parent/child grouping; matches are highlighted rather than filtered.

The focused input owns keyboard handling. Up/Down moves a transient candidate without changing the active project, Enter activates the candidate, and Escape cancels. Pointer activation keeps the Sidebar's existing immediate-switch behavior. Cancellation restores the element focused before search when it still exists; activation never restores focus into a project the user left.

**Reason:** Explicit input focus gives search unambiguous keyboard ownership without adding a second global arbitration path across xterm, Agent inputs, webviews, overlays, and IME composition. Keeping search as location rather than filtering preserves spatial and worktree-group context and leaves the funnel as the single control that reduces the list. Separating candidate from active project prevents arrow navigation from repeatedly swapping the content pane.

**Do not change casually because:** Hidden metadata in matching can produce results whose matching text is not visible. Searching outside the connected-only projection can produce an invisible candidate. Activating on candidate movement makes cancellation ambiguous and causes avoidable Terminal, Agent, or Web view switches. A future activation shortcut requires its own product decision and keybinding compatibility review.

### Gotchas

- Search navigation must use real visual project indices rather than indices from a separately filtered collection.
- The input key handler must defer ArrowUp, ArrowDown, Enter, and Escape while IME composition is active; see `keybindings-shell#6`.
- Icon toggle and Escape restore prior focus, while activation delegates focus to the destination project's existing view lifecycle.

## projects#10 — One ordered typed list owns project startup tabs  ·  [Decision]

**Decision:** `Project.defaultTabs` is the only connect-time startup source and is always non-empty. Terminal, Web, and Agent are disjoint template variants in one ordered list; connect creates each template in order. Agent templates carry an explicit registry-resolved provider and must be unique by provider within a project. Project Settings allows temporary duplicate selections but validates them only on Save, keeps unavailable persisted provider ids recoverable, and never uses a separate Agent default or startup boolean.

Runtime `Save to Default` preserves the actual tab variant and its kind-specific payload. Manual Agent creation always carries an explicit provider. Neither path guesses a provider or falls back to a project-level default.

**Reason:** One list directly represents what connect will open, preserves ordering across all tab kinds, and removes contradictory state between an Agent provider field, an auto-open flag, and the existing tab templates.

**Do not change casually because:** Reintroducing a dormant default provider, implicit Terminal, or separate Agent-open switch creates a second startup authority. Multiple same-provider Agent tabs remain out of scope because session ids, preferences, and runtime uniqueness are provider-keyed.

## projects#11 — Quick Commands execute only against Terminal tabs  ·  [Decision]

**Decision:** Project Settings offers named Quick Command targets only from Terminal startup templates. Runtime execution validates both named targets and `Current tab`; it sends PTY input only to a Terminal. Agent, Web, missing, and stale targets are refused with a project-visible reason and diagnostic context. Stored stale targets are preserved rather than silently rewritten, including when a Worktree startup override removes their named tab.

**Reason:** A shell command has no defined meaning as an Agent prompt or Web action. Validating immediately before PTY input protects both current-tab changes and configuration/runtime drift while preserving user data for explicit repair.

**Do not change casually because:** UI-only filtering is insufficient: Worktree inheritance, renamed/removed tabs, and legacy configuration can still produce stale runtime targets. Execution must retain the Terminal type guard.

## projects#12 — Search activation uses the current matches when candidate state lags  ·  [Gotcha]

**Symptom:** Typing a project name and immediately pressing Enter can leave the search input open even though a matching row is highlighted.

**Root cause:** Matching rows update from the query during render, while the selected candidate ID is reset in a later effect. Enter can run between those steps with a null or stale candidate ID.

**Fix / note:** Enter resolves the candidate against the current match list and falls back to its first entry when the stored ID is absent. Arrow navigation still uses the explicit candidate state; an empty match list remains inactive. The Sidebar unit test covers null and stale IDs, and the project-search E2E covers immediate Enter after typing.

**Related:** `projects#9`, `src/renderer/components/Sidebar.tsx`, `e2e/sidebar-project-search.spec.ts`.
