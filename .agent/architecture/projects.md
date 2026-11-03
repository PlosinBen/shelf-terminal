---
type: architecture
title: Projects
related:
  - context/projects
  - contracts/projects
---

# Projects

Project configuration has one durable authority in the main process. Persisted documents are decoded into a current canonical project collection before any consumer sees them; renderer runtime state is a second layer composed by project identity.

## Flow

```text
Persisted project document
  -> opaque file read
  -> version-aware loader and canonical validation
  -> ready main project repository
       -> main project queries
       -> project operation boundary
            -> renderer repository client
            -> mutation coordinator
            -> canonical collection reconcile
            -> canonical Project + runtime-by-project-id
            -> flat readonly ProjectView
            -> components

Canonical project mutation
  -> enqueue operation intent, not a prebuilt project snapshot
  -> read latest canonical base inside the serialized operation
  -> compare editor original values or apply a named background operation
  -> construct candidate collection
  -> for add: reject an effective target already in the canonical collection
  -> format newest document
  -> atomic replace
  -> publish main canonical collection
  -> authoritative renderer refresh

Ordered startup templates
  -> connect handler, index order
       -> Terminal template -> terminal runtime tab
       -> Web template -> web runtime tab
       -> Agent template -> live-registry validation -> agent runtime tab

Quick Command execution
  -> resolve current or named runtime tab
  -> Terminal -> terminal input
  -> Agent / Web / missing -> visible refusal + diagnostic

Folder selection
  -> derive lexical effective target
  -> scan reconciled project order
       -> match: activate first project -> connect only when it has no runtime tabs
       -> no match: add intent -> canonical project mutation

Visual project order + runtime tab presence + transient filter mode
  -> visual-group connectivity
  -> visible real project indices
  -> sidebar rows / directional project navigation
       -> displayed row labels + explicit search query
       -> transient matches + candidate navigation
       -> explicit candidate activation -> active project
```

## Boundaries

Versioned loading also migrates provider-specific saved selections into the canonical shape; provider connection consumes only that shape. Loading does not write the file, and the next durable mutation saves the current version.

The persistence boundary alone understands raw bytes, legacy/current persisted shapes, schema versions, formatting, atomic replacement, and the nonempty-to-empty backup guard. Missing files produce an empty canonical collection; malformed or unsupported documents fail before a repository becomes ready.

The main repository owns canonical identity, defaults, grouping/order invariants, durable project-level mutations, and main-process queries. New project creation rejects an effective target already present in the canonical collection, while document loading and project save/update do not apply retroactive target validation. The repository publishes a candidate collection only after persistence succeeds. Removed-project session, history and storage cleanup is post-commit work with an explicit retry result, not part of the config transaction.

The canonical startup list is non-empty and is the only connect-time tab authority. Agent rows reference stable conversation records, independently of runtime mounting. Multiple Views may share a provider, never a conversation identity. Provider availability remains a runtime registry concern. Manual Agent creation registers a fresh conversation with empty saved preferences before mounting; saving to startup preserves the same identity. A startup or live runtime reference retains its conversation; an unreferenced conversation is collected after runtime teardown and history writers settle. Quick Commands remain Terminal-only.

Conversation preferences are separate from startup layout. Background reports target the stable conversation identity and cannot make an editor's unchanged layout stale. Editing an existing row retains its identity unless its provider changes; new/replaced Agent rows receive new identities atomically with the layout commit. Removing a startup reference retains a still-mounted conversation until close. Startup collection handles records left unused after interrupted runtime lifetimes.

Collection shares the per-project mutation queue with startup edits and View creation. It deletes owned client history before forgetting canonical metadata, preserving retry inventory on failure. Project deletion stages a durable client-history cleanup request before committing config removal; completion removes that request with the corresponding history. Startup retries requests only when no surviving Project owns the session. Unknown history without ownership evidence is never swept; provider-native conversation storage is outside this flow.

The renderer repository client is a stateless operation adapter private to the App-side coordinator. A successful mutation is followed by an authoritative collection query; only that result is reconciled into renderer state. A failed mutation leaves the current renderer collection unchanged, while a post-commit refresh failure retries only the query.

Project edits have a separate draft lifetime. Opening the editor captures original editable values;
runtime and canonical refreshes do not replace the draft. Save submits only changed fields with their
original values. Main rejects an entire edit only when a submitted field differs from both its original
and requested value, leaving unrelated background changes intact. Conflict feedback retains the draft
and permits explicit reset from refreshed saved values. The editor waits for save/refresh completion
before closing and ignores completion from an obsolete edit session.

Agent reports, session bindings, startup-tab appends and conditional preference removal carry their
operation meaning rather than caller-built maps or arrays. Comparison and merging belong to main's
existing write serialization. Renderer update ordering includes recovery and refresh so a failed older
report cannot retry after a newer report; it is per project and does not lock config while editing.

The renderer project store owns runtime/reactive state: tabs, active tab, split tab, folder validity, active/editing project identity, notices, and connection health. Runtime state is preserved by project id when a fresh canonical collection is reconciled. Folder selection compares effective targets against current project views and emits either an open-existing or add intent; App owns activation, conditional connection, and repository side effects. Components do not know persisted schema or call project-config operations.

Sidebar visibility is a projection over authoritative visual order, not a second project collection. Project Search operates only on that projection and its displayed row labels; it does not remove or reorder rows, and its transient candidate does not become the active project until explicit activation. Stable mounted-view order is deterministic by project identity so reorder, insertion, or deletion cannot remount unaffected terminal, agent, or web subtrees.
