---
type: context
title: Testing Practices
related:
  - context/worktree
---

# Testing Practices

## testing#1 — Promise-bearing tests explain the contract they protect  ·  [Decision]

**Decision:** A unit, integration, or end-to-end test that protects a non-obvious promise to users, agents, external interfaces, or another system layer carries nearby rationale stating the promise, why its assertions are required behavior rather than incidental implementation detail, and which model-facing, user-facing, or contract surface must be reviewed if the behavior changes. Ordinary pure functions, obvious CRUD, and tests whose names fully state the behavior do not require this annotation.

**Reason:** Cross-layer tests often look overly specific when read after their original feature context is gone. Recording the contract next to the assertions lets a future reader distinguish deliberate compatibility and safety coverage from replaceable mechanics without coupling the test to transient planning notes or exact prose snapshots.

**Do not change casually because:** Removing or weakening an unexplained assertion can silently break a promise exposed on another surface. Requiring the annotation everywhere would add noise and make the genuinely load-bearing explanations harder to notice.
