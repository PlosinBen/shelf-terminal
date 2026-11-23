---
type: architecture
title: Worktree Lifecycle
related:
  - context/worktree
  - contracts/ipc-channels
---

# Worktree Lifecycle

Create and full Finish/Abandon are user-committed UI transactions around Git state. Agents may propose those actions. A separate direct merge operation executes in main and preserves the child environment; it returns the actual Git result rather than opening a renderer gate.

## Flow

Create:

```text
Proposal or user menu
  → New Worktree gate
  → optional project feature-note binding
      disabled → omit note discovery
      enabled → list direct note candidates or show a non-blocking listing error
  → choose same-provider preference source (caller/active View, sole match, or explicit selection)
  → user confirms independent Agent / Terminal startup selection
  → main validates final selection before any Git creation
  → create child checkout
  → optionally migrate selected feature notes into child as one all-or-nothing batch
  → create child project with the binding captured as a transaction snapshot
      main allocates a fresh Agent identity and snapshots selected parent View prefs
  → auto-connect child
```

Direct merge:

```text
MCP request with explicit target branch
  → trusted caller project and parent resolution
  → lifecycle guard and live source identity/commit inspection
  → shared repo lock + target validation + ff-only merge
  → return success receipt or MCP error with Git diagnostics
  → retain child project, checkout, branch, sessions, focus and notes
```

UI merge and direct merge share the same main-side repo lock and target checks. The direct path emits the normal worktree audit card but does not use renderer cleanup or completion-focus logic. Response loss leaves the caller uncertain about the Git outcome; it does not imply rollback.

Finish:

```text
Proposal or user menu
  → Finish gate
  → full Finish only: one configured-note preflight (remaining notes or scan errors block)
  → verify feature worktree has default-status clean state
  → fast-forward selected target only
  → Only merge unchecked (default)
      → non-force remove child checkout
      → delete source branch when one exists
      → remove child project
      → focus parent project
      → show parent project completion banner
    Only merge checked
      → retain branch, checkout, project, tabs, conversations, and feature notes
      → retain current focus
      → set child project merge-success banner
```

Abandon:

```text
User menu
  → Abandon gate
  → if the child snapshot is enabled, list remaining child feature notes (errors block)
  → non-empty notes require explicit discard confirmation; recheck paths on approval
  → never copy or move notes to the parent
  → non-force remove child checkout
  → optionally delete feature branch with merged/unmerged warning semantics
  → remove child project
  → focus parent project by identity
```

## Boundaries

The merge-back boundary is only the fast-forward advancement of the selected target. It does not rebase, merge with conflicts, squash, delete files, remove worktrees, or announce success.

The close gate sequences the transaction and stops at the first failure. A preflight failure leaves the target and child environment unchanged. Later failures report the failed step without claiming rollback: merge may already have succeeded, or the checkout may already have been removed before branch deletion failed. Errors can be sent to the child agent.

Create gates also stop on the first failed transaction step. If note migration fails, the renderer asks Git to remove the just-created child checkout; if that rollback fails too, both full errors remain visible and can be sent to the base project's agent tab. Create/finish/abandon failures log structured context through the app log for post-mortem recovery.

Shelf owns feature-note discovery, create-time migration, and close-time checks, but not the notes' authoring lifecycle or directory convention. The optional project binding connects this mechanism to a workflow-owned directory. Main-project edits affect future worktrees only; close uses the child's creation-time snapshot so a later edit cannot redirect an in-flight transaction.

The completion banner is project-level UI state. It is not an agent timeline message and does not create or mutate an agent conversation.

## Repository reconciliation

A successful Connect that creates tabs, or an explicit Rescan, sends one project-id intent to the central renderer coordinator. Main resolves the owning main project and performs background target discovery through its connector. This does not require a main Terminal or Agent tab. Concurrent requests for the same main share the scan through publication.

Both entry points use the same scan. When a Git snapshot is available and a registered child has no parent, main returns the orphan IDs for review before saving. After confirmation and history staging, the scan revalidates the current snapshot and commits orphan removals and discovery together.

The scanner reads a complete Git worktree snapshot, checks target checkout identity and access, excludes the main checkout, and matches existing children by repository/worktree identity. Confirmed non-repositories with no children skip the operation. Indeterminate access or inconsistent snapshots fail without changing availability or membership.

The repository serializes batch publication with ordinary project writes. A topology baseline and lifecycle generation reject obsolete results; unrelated session/preference writes remain valid and are preserved. Discovered children inherit current parent environment, initialization, Quick Commands and note binding, but not tabs, conversations or Agent preferences. They start with one Terminal. User-created children start with the selected fresh Agent, Terminal, or both. Their Agent can copy same-provider prefs through the explicit creation source; an empty selection is rejected before checkout creation. Existing children receive only scan-owned metadata. Config persistence precedes canonical publication.

Renderer refreshes the current canonical collection, disconnects missing children through the usual tab teardown path, and preserves focus. Missing availability is persisted separately from runtime folder warnings. Recovery clears the validated child's old folder warning and returns it to the disconnected view. Error/busy presentation is runtime state keyed by the main project; errors offer Rescan beside that main without replacing project content. A refresh failure after commit triggers canonical refresh, not batch replay.

Create, Finish and Abandon bracket their full UI transactions with a main-project lifecycle guard. A scan does not publish across those operations. External Git remains outside that guard, so snapshot changes fail and require a new scan rather than pretending to provide a cross-process transaction.

## Detached merge sources

The close gate inspects the source checkout at approval. Fast-forward uses the inspected commit in either target topology; an optional expected commit rejects a source that changed before merge. Before cleanup, the gate rechecks source identity, branch and commit. A detached source has a display label but no branch deletion argument. Completion carries the display label and explicit checkout-removal outcome.
