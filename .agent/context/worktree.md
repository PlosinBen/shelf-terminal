---
type: context
title: Worktree Lifecycle
related:
  - architecture/worktree
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

## worktree#4 — Finish is fast-forward-only and recovery rebases the feature  ·  [Decision]

**Decision:** Finish advances the selected target only by fast-forward. If the target has moved and the feature is no longer fast-forwardable, the error instructs the agent to rebase the feature worktree onto the target, resolve conflicts there, re-verify, and retry Finish.

**Reason:** The target history stays linear without squashing away task-sized feature commits. Rebase is explicit work in the feature checkout, not an automatic side effect of clicking Finish, so conflicts remain visible and recoverable in the place where the agent can fix and test them.

**Do not change casually because:** Merging the target into the feature makes that synchronization merge permanent after the eventual fast-forward. Auto-rebasing inside Finish can leave the worktree half-rebased from a UI close action.

## worktree#5 — Finish requires default-status clean feature state, then teardown is non-force  ·  [Decision]

**Decision:** Before any target ref movement, Finish checks the feature worktree with default `git status --porcelain`. Any tracked/staged/deleted/renamed change or untracked non-ignored file blocks merge-back with a `feature-dirty` result. Ignored files do not block merge-back, but close teardown uses non-force `git worktree remove`, so Git can refuse overlooked leftovers instead of deleting them.

**Reason:** The hard merge gate should match the user's ordinary status list: if normal `git status` has something to resolve, Finish must not advance the target. Ignored files are often caches, logs, or transient feature notes; they are better handled by teardown preservation/failure than by making every ignored file block a merge.

**Do not change casually because:** Moving refs while default status is dirty can make the UI proceed into cleanup even though user work is not represented by the committed feature tip. Adding `--force` to teardown reintroduces silent data loss for ignored or otherwise overlooked files.

## worktree#6 — Carried feature notes are restored before close teardown  ·  [Decision]

**Decision:** Before Finish or Abandon removes a child checkout, any remaining `.agent/features/*.md` notes in the child are copied back to the parent checkout, verified, and then removed from the child. No child notes is a successful no-op. If the parent destination already exists or verification fails, close stops and leaves the child checkout in place.

**Reason:** Feature notes are transient working memory and are normally gitignored, so they do not travel through merge-back. Restoring before teardown preserves that state without turning an already-consolidated/deleted note into an error.

**Do not change casually because:** Worktree removal is the last chance to avoid losing ignored note files. Overwriting a parent note during restore would be another form of silent data loss, so destination conflicts must stay fail-loud.

## worktree#7 — Finish completion is parent project UI, not agent conversation state  ·  [Decision]

**Decision:** After merge-back, note restore, worktree removal, and optional branch deletion all succeed, the renderer removes the child project, focuses the parent by project identity, and shows a dismissible parent project banner: `Merged <feature> → <target> and closed the worktree`.

**Reason:** Worktree integration is a project-level lifecycle event. It must be visible even when the parent currently shows Terminal or Web, and it should not pollute an agent transcript or create an agent tab just to acknowledge a UI transaction.

**Do not change casually because:** Announcing success before the entire close sequence finishes creates false completion after partial teardown failures. Routing completion into an agent timeline couples project lifecycle state to a provider session that may not exist or may not be the right audience.

## worktree#8 — Create may carry multiple feature notes, migrated as one batch  ·  [Decision]

**Decision:** The New Worktree dialog lets the user select zero or more `.agent/features/*.md` notes. Create-time migration accepts the selected relative paths as one batch. It copies and verifies every selected note into the child checkout before deleting any base copy; if a copy/verify step fails, base notes stay intact and any child-side copies already made are removed.

**Reason:** A single worktree can intentionally carry several small feature notes, and close already restores all remaining child notes. Looping the old single-note move would delete earlier base notes before later notes were proven safe; if the caller then removed the child checkout, those earlier notes could be lost.

**Do not change casually because:** Feature notes are often gitignored transient working memory. Batch create migration must preserve all-or-nothing semantics across the whole selected set, not just within each individual file.

## worktree#9 — Worktree transaction failures are visible now and logged for later  ·  [Decision]

**Decision:** Create, Finish, and Abandon failures surface the full error text in the dialog and write structured context to the persistent app log through the renderer debug-log bridge. Create migration failure also attempts rollback; if rollback fails, the dialog shows both full errors and can send a recovery prompt to the base project's agent tab. Finish/Abandon keep their existing Send-to-agent behavior to the worktree agent tab.

**Reason:** These flows mutate git state and can stop midway. The user needs the exact failure immediately for recovery, while logs preserve operation, project ids, branches/targets, cwd/worktree paths, failed step, and full error text after the dialog is closed.

**Do not change casually because:** Hiding rollback or teardown details makes partial git-state transactions hard to repair and violates the fail-loud rule for possible data loss or orphaned worktrees.

## worktree#10 — Create proposals accept legacy single-note and preferred multi-note inputs  ·  [Decision]

**Decision:** `propose_worktree_create` accepts `note?: string` as a legacy alias and `notes?: string[]` as the preferred multi-note input. Main normalizes both into a trimmed, deduped `notePaths: string[]` proposal payload before renderer prefill. The fake provider's compact `worktree_create:<branch> [<note>]` command remains single-note shorthand; multi-note behavior is covered through direct app-tool, MCP schema, and renderer prefill tests.

**Reason:** Older agents and E2E smoke paths may still call the single-note form, while the New Worktree dialog and create-time migration already support selecting and moving several feature notes as one batch. Normalizing at the bridge boundary keeps renderer code on the current payload shape and keeps the proposal tool side-effect free.

**Do not change casually because:** Removing `note` would break existing callers, and moving merge/dedup logic downstream would reintroduce multiple prefill shapes in the renderer. Expanding the fake shorthand would add another mini-parser that is not part of the model-facing contract.
