---
type: context
title: Worktree Lifecycle
related:
  - contracts/app-tool-bridge
  - contracts/ipc-channels
  - context/agent-providers
---

# Worktree Lifecycle

## worktree#1 — Lifecycle proposals are side-effect free; user clicks commit  ·  [Decision]

**Decision:** Agents may propose creating or finishing a worktree through `propose_worktree_create` and `propose_worktree_finish`. The tools only open the prefilled dialog or Finish gate; the user performs the actual Create or Finish click. Abandon remains UI-only.

**Reason:** Creating a worktree and merging or removing one changes git state. Splitting proposal from commit lets an agent remove hand-off friction without creating orphaned worktrees or merging unexpectedly.

**Do not change casually because:** A tool that executes lifecycle operations would bypass the human review boundary. Keep any future lifecycle proposal equally non-mutating.

## worktree#2 — Finish proposals are valid only for a child project  ·  [Decision]

**Decision:** `propose_worktree_finish` checks the caller project for `parentProjectId` before sending renderer IPC. A main-project call returns an explanatory error to the agent; the Finish gate retains its child-only guard as a backstop.

**Reason:** The bridge exists for every project, while only a child has a worktree to finish. Failing at the operation boundary gives the caller actionable feedback instead of silently opening nothing.

**Do not change casually because:** Moving this check only into the renderer makes an invalid agent call look successful and hides the error from the actor that can correct it.

## worktree#3 — A child may override its inherited boot provider at creation  ·  [Decision]

**Decision:** The New Worktree dialog defaults its provider selector to the parent provider (or Claude when unset) and passes the selected provider into the child config. The parent configuration is not changed.

**Reason:** Separate worktrees can host different agent vendors while retaining the existing inherited default when no choice is made.

**Do not change casually because:** Provider choices come from the central provider registry; do not hardcode a separate worktree list.
