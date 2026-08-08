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
  -> construct candidate collection
  -> format newest document
  -> atomic replace
  -> publish main canonical collection
  -> authoritative renderer refresh

Visual project order + runtime tab presence + transient filter mode
  -> visual-group connectivity
  -> visible real project indices
  -> sidebar rows / directional project navigation
```

## Boundaries

The persistence boundary alone understands raw bytes, legacy/current persisted shapes, schema versions, formatting, atomic replacement, and the nonempty-to-empty backup guard. Missing files produce an empty canonical collection; malformed or unsupported documents fail before a repository becomes ready.

The main repository owns canonical identity, defaults, grouping/order invariants, durable project-level mutations, and main-process queries. It publishes a candidate collection only after persistence succeeds. Removed-project storage and secrets cleanup is post-commit work with an explicit retry result, not part of the config transaction.

The renderer repository client is a stateless operation adapter private to the App-side coordinator. A successful mutation is followed by an authoritative collection query; only that result is reconciled into renderer state. A failed mutation leaves the current renderer collection unchanged, while a post-commit refresh failure retries only the query.

The renderer project store owns runtime/reactive state: tabs, active tab, split tab, folder validity, active/editing project identity, notices, and connection health. Runtime state is preserved by project id when a fresh canonical collection is reconciled. Components read flat project views and emit intents; they do not know persisted schema or call project-config operations.

Sidebar visibility is a projection over authoritative visual order, not a second project collection. Stable mounted-view order is deterministic by project identity so reorder, insertion, or deletion cannot remount unaffected terminal, agent, or web subtrees.
