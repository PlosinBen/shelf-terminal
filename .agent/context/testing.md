---
type: context
title: Testing Practices
related:
  - context/worktree
  - context/skills
---

# Testing Practices

## Worktree delegation verification

`npm run test:unit -- src/main/agent/delegation.test.ts src/main/agent/message-sender.test.ts src/main/agent/delegation-runtime.test.ts`
驗記憶體角色／授權、介入、單份結果、picker 往返、queue receipt 與晚到對帳。
`remote.test.ts`／`dispatcher-connection.test.ts` 驗 trusted logical View context；
既有 Shelf SDK smoke／adapter contract 也包含委派工具。

`npm run test:e2e -- e2e/agent-delegation.spec.ts` 使用真 temporary Git worktree 與
fake provider 的正式 callMain，走 picker → main service → exec queue → 雙端 UI。
涵蓋 A→B 接續、結果不自動觸發 main、介入／停止、未提取結果的關閉提醒與重啟
清空。這不是 live 模型的工具選擇／approval 或 SSH／Docker／WSL 部署證明。

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

## Agent input verification

Queued cancellation 的 server 結果由 `agent-server/send-queue.test.ts` 驗，remote RPC
correlation／非法結果／timeout 由 `src/main/agent/remote.test.ts` 驗；renderer store／
reconcile 測試保護取消中內容、snapshot 先於結果及 running promotion／history。
`e2e/agent-flows.spec.ts` 的 queued cancellation 案例以 main IPC gate 控制取消送達
時機，仍走實際 exec queue／fake provider，驗確認前保留 chip、取消晚於 running
時有且只有一份 IndexedDB user row，以及失敗後保留內容並允許明確重試。

`src/main/agent/message-sender.test.ts` 以可控 pending execution 驗共通提交與執行完成
分離、queued／running 確認、typed error、timeout／晚到確認、投影隔離與 close cleanup。
`e2e/agent-flows.spec.ts` 的 submission 案例走實際 IPC／exec queue、fake provider，
驗執行尚未完成時 running／queued 均已返回成功，以及 Caller 顯示 typed rejection。
Telegram unit mock agent sender／API，驗 Caller 組裝及錯誤通知，不證明 live Telegram。

`src/shared/agent-input.test.ts` 驗 factory 身分、原文／附件 metadata 與入口來源限制；
`agent-server/input-prompt.test.ts` 驗共通回覆指示與 slash 語法保留。
Claude `config-apply.test.ts`、Copilot `copilot.test.ts` 與 Codex `index.test.ts` 以 mock
SDK／協定對口檢查真正 provider 的模型輸入轉換，不呼叫 live 模型。
`e2e/agent-flows.spec.ts` 使用 fake provider，涵蓋實際輸入→main→agent-server queue→
renderer→IndexedDB metadata 持久化，以及既有 queue／附件／slash 行為。Worktree
失敗回報入口由 `e2e/worktree-finish-send-to-agent.spec.ts` 覆蓋。

手動 bundle driver 的 `scripts/agent-input.mjs` 在記憶體中使用既有 esbuild 載入正式
factory，讓 `.mjs` probe 不需另一套 TypeScript runtime 或重複 Message 規則。
driver 的 send frames 經此 Caller adapter 轉成 inputMessage，控制 frames 原樣傳遞；
image-only smoke 先建立暫存圖片附件，退出時清理。這些 live Claude／Copilot probe
仍需要各自登入與執行環境，不能以 unit／fake-provider E2E 通過推定 live 模型通過。
