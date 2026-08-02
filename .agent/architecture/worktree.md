---
type: architecture
title: Worktree Lifecycle
related:
  - context/worktree
  - contracts/ipc-channels
---

# Worktree Lifecycle

Worktree lifecycle operations are user-committed UI transactions around Git state. Agents may propose lifecycle actions, but the renderer gate owns the actual create, finish, abandon, cleanup, parent focus, and visible completion flow.

## Flow

Create:

```text
Proposal or user menu
  → New Worktree gate
  → optional project feature-note binding
      disabled → omit note discovery
      enabled → list direct note candidates or show a non-blocking listing error
  → create child checkout
  → optionally migrate selected feature notes into child as one all-or-nothing batch
  → create child project with the binding captured as a transaction snapshot
  → auto-connect child
```

Finish:

```text
Proposal or user menu
  → Finish gate
  → verify feature worktree has default-status clean state
  → fast-forward selected target only
  → if the child snapshot is enabled, restore remaining child feature notes to parent
  → non-force remove child checkout
  → optionally delete feature branch
  → remove child project
  → focus parent project
  → show parent project completion banner
```

Abandon:

```text
User menu
  → Abandon gate
  → if the child snapshot is enabled, restore remaining child feature notes to parent
  → non-force remove child checkout
  → optionally delete feature branch with merged/unmerged warning semantics
  → remove child project
```

## Boundaries

The merge-back boundary is only the fast-forward advancement of the selected target. It does not rebase, merge with conflicts, squash, delete files, remove worktrees, or announce success.

The close gate sequences the transaction and stops at the first failure. A close failure leaves the child project and checkout visible so the user or agent can recover from the exact step that failed.

Create gates also stop on the first failed transaction step. If note migration fails, the renderer asks Git to remove the just-created child checkout; if that rollback fails too, both full errors remain visible and can be sent to the base project's agent tab. Create/finish/abandon failures log structured context through the app log for post-mortem recovery.

Shelf owns feature-note discovery, migration, and restore, but not the notes' authoring lifecycle or directory convention. The optional project binding connects this mechanism to a workflow-owned directory. Main-project edits affect future worktrees only; close uses the child's creation-time snapshot so a later edit cannot redirect an in-flight transaction.

The completion banner is project-level UI state. It is not an agent timeline message and does not create or mutate an agent conversation.
