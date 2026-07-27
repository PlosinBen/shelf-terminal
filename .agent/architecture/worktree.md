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
  → create child checkout
  → optionally move selected feature note into child
  → create child project
  → auto-connect child
```

Finish:

```text
Proposal or user menu
  → Finish gate
  → verify feature worktree has default-status clean state
  → fast-forward selected target only
  → restore remaining child feature notes to parent
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
  → restore remaining child feature notes to parent
  → non-force remove child checkout
  → optionally delete feature branch with merged/unmerged warning semantics
  → remove child project
```

## Boundaries

The merge-back boundary is only the fast-forward advancement of the selected target. It does not rebase, merge with conflicts, squash, delete files, remove worktrees, or announce success.

The close gate sequences the transaction and stops at the first failure. A close failure leaves the child project and checkout visible so the user or agent can recover from the exact step that failed.

The completion banner is project-level UI state. It is not an agent timeline message and does not create or mutate an agent conversation.
