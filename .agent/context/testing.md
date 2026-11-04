---
type: context
title: Testing Practices
related:
  - context/worktree
  - context/skills
---

# Testing Practices

## testing#1 — Promise-bearing tests explain the contract they protect  ·  [Decision]

**Decision:** A unit, integration, or end-to-end test that protects a non-obvious promise to users, agents, external interfaces, or another system layer carries nearby rationale stating the promise, why its assertions are required behavior rather than incidental implementation detail, and which model-facing, user-facing, or contract surface must be reviewed if the behavior changes. Ordinary pure functions, obvious CRUD, and tests whose names fully state the behavior do not require this annotation.

**Reason:** Cross-layer tests often look overly specific when read after their original feature context is gone. Recording the contract next to the assertions lets a future reader distinguish deliberate compatibility and safety coverage from replaceable mechanics without coupling the test to transient planning notes or exact prose snapshots.

**Do not change casually because:** Removing or weakening an unexplained assertion can silently break a promise exposed on another surface. Requiring the annotation everywhere would add noise and make the genuinely load-bearing explanations harder to notice.

## Shelf MCP verification

`npm run test:unit -- agent-server/shelf-tool-sdk-smoke.test.ts agent-server/shelf-tool-contract.test.ts`
執行兩種互補檢查：SDK smoke 使用真正的 Claude SDK／Zod 與正式共用工具定義，透過
in-memory MCP client 驗證建構及 `tools/list` 的名稱、描述與輸入 schema；契約測試 mock
Claude SDK builders，但使用真正 HTTP MCP client／host，驗證兩個 adapter 的工具 surface、
main operation 映射與錯誤回傳。兩者都不呼叫真實模型，也不需要登入憑證；不驗證 CLI／
模型實際呼叫工具或使用者權限互動。一般 `npm run test:unit` 會包含兩者。
