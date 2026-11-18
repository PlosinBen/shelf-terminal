---
type: context
title: Testing Practices
related:
  - context/worktree
  - context/skills
---

# Testing Practices

## Session configuration control verification

`agent-server/session-config-control.test.ts` 與 `send-queue.test.ts` 驗 live／deferred control、
FIFO start barrier、跨 key 排他、同值 settlement、等待安全邊界不算 apply timeout、
uncertain 保留 queued input，以及 wire envelope 不得洩漏至結果。各 provider 的 config
測試走 mock SDK／ACP／app-server，驗確認與無 timeline／idle side effect，不呼叫 live 模型。
`src/main/agent/remote.test.ts` 驗 request correlation／close invalidation；renderer store
測試驗 incarnation 與 terminal monotonicity。

`npm run test:e2e -- e2e/agent-flows.spec.ts` 的 session setting／deferred effort／uncertain
config／rejected config 案例走實際 IPC、exec queue 與 fake provider，驗 busy 時 direct
control、slash picker 的訊息路徑、確認後保存、獨立錯誤與使用者 reconnect。失敗時保存
main log 至 Playwright attachments，fixture 清理不抹掉證據。這不是 live provider 或
SSH／Docker／WSL 的執行中 setter 支援證明。

## Worktree create verification

`e2e/worktree-manual-create.spec.ts` uses real temporary Git repositories and the production build with a fake Agent backend. It covers the independent startup selections, proposal Agent prefill and user overrides, empty-selection UI/Enter and main IPC rejection, fresh child records and runtime tabs, same-provider preference copying, ambiguous source selection, trusted MCP caller selection after a View switch, native permission/approval initialization, and note migration. Failure teardown saves main logs and the project document into that test's output directory, plus a screenshot when a live window exists, before removing temporary userData. Legacy-v0 project seeds express their Agent through defaultAgentProvider and legacy session/prefs maps; typed Agent defaultTabs require a later schema.

## Worktree scan verification

`e2e/worktree-reconciliation.spec.ts` 的首次 target probe 失敗案例，在 Connect
成功後 gate 第一個實際 scan main handler，再暫時移走 cwd；驗真 probe 錯誤與
UI Rescan 恢復，不 mock scan 結果。不要在 Connect 前移走目錄，否則會與啟動時
目錄驗證競態，測到 disabled Connect 而非 probe recovery。

## Worktree delegation verification

`npm run test:unit -- src/main/agent/delegation.test.ts src/main/agent/message-sender.test.ts src/main/agent/delegation-runtime.test.ts`
驗記憶體角色／授權、介入、單份結果、picker 往返、queue receipt 與晚到對帳。
`remote.test.ts`／`dispatcher-connection.test.ts` 驗 trusted logical View context；
既有 Shelf SDK smoke／adapter contract 也包含委派工具。

`npm run test:e2e -- e2e/agent-delegation.spec.ts` 使用真 temporary Git worktree 與
fake provider 的正式 callMain，走 picker → main service → exec queue → 雙端 UI。
涵蓋 A→B 接續、結果不自動觸發 main、介入／停止、未提取結果的關閉提醒與重啟
清空。Fixture 用 fake capabilities delay 保護啟動 readiness 等待：`idle` 只表示
沒有執行中的 turn，picker 建立候選快照前必須等兩端 input ready。失敗時保存
main log，避免 fixture 清理 userData 後丟失初始化證據。這不是 live 模型的工具選擇／
approval 或 SSH／Docker／WSL 部署證明。

## testing#1 — Promise-bearing tests explain the contract they protect  ·  [Decision]

**Decision:** A unit, integration, or end-to-end test that protects a non-obvious promise to users, agents, external interfaces, or another system layer carries nearby rationale stating the promise, why its assertions are required behavior rather than incidental implementation detail, and which model-facing, user-facing, or contract surface must be reviewed if the behavior changes. Ordinary pure functions, obvious CRUD, and tests whose names fully state the behavior do not require this annotation.

**Reason:** Cross-layer tests often look overly specific when read after their original feature context is gone. Recording the contract next to the assertions lets a future reader distinguish deliberate compatibility and safety coverage from replaceable mechanics without coupling the test to transient planning notes or exact prose snapshots.

**Do not change casually because:** Removing or weakening an unexplained assertion can silently break a promise exposed on another surface. Requiring the annotation everywhere would add noise and make the genuinely load-bearing explanations harder to notice.

## testing#2 — Local Electron overrides can change unrelated installed dependencies  ·  [Gotcha]

`npm install --no-save --package-lock=false electron@<version>` can re-resolve other semver
ranges even though tracked manifests remain unchanged. The runtime-version tests compare
installed provider packages with pinned deployment versions, so this drift can fail verification
without a source change. For an Electron-only local override, preserve the lockfile-resolved
dependency tree and verify installed versions as well as the Electron package and binary.
Reusing an isolated Electron package requires checking that its dependencies are satisfied by
the locked tree. A clean package diff alone does not establish an Electron-only environment.

## testing#3 — Agent-open helpers wait for the newly requested View  ·  [Gotcha]

`openAgentTab` waits for the tab count to increase before checking Agent visibility.
Main allocates the View asynchronously; an existing Agent can satisfy a visible-pane check
before the new tab commits. A click can then bind that old textarea just before its pane
becomes hidden but remains attached, leaving the action retrying an invisible element.
Visibility alone does not identify the requested new View. Initialization readiness is a
separate barrier so init-failure/delay tests can still inspect the starting pane.

The temporary-View cleanup E2E delays the real second View allocation and checks the tab
count immediately after the helper returns; an auto-waiting assertion there would conceal
premature helper completion. The case then exercises send, close and reconnect normally.

## Shelf MCP verification

`npm run test:unit -- agent-server/shelf-tool-sdk-smoke.test.ts agent-server/shelf-tool-contract.test.ts`
執行兩種互補檢查：SDK smoke 使用真正的 Claude SDK／Zod 與正式共用工具定義，透過
in-memory MCP client 驗證建構及 `tools/list` 的名稱、描述與輸入 schema；契約測試 mock
Claude SDK builders，但使用真正 HTTP MCP client／host，驗證兩個 adapter 的工具 surface、
main operation 映射與錯誤回傳。兩者都不呼叫真實模型，也不需要登入憑證；不驗證 CLI／
模型實際呼叫工具或使用者權限互動。一般 `npm run test:unit` 會包含兩者。

## Agent input verification

`e2e/agent-flows.spec.ts` 的 add-tab menu 案例驗證明確 provider 選擇、總 tab
上限與同 provider 雙 View 的獨立對話；已開啟某 provider 不會禁用其 menu。
Default／prefs／reconnect 的多 View 隔離由 `e2e/multi-agent-views.spec.ts` 覆蓋。
Project editor 新增同 provider startup rows 的穩定 session bindings、磁碟保存與
reconnect 由 `e2e/features.spec.ts` 覆蓋；multi-View 案例失敗時同樣保存 main log。
兩者使用 fake provider，不代表 live provider 已通過驗證。

`components/agent/AgentInputSourceHeader.test.ts` 驗來源標籤映射、無 metadata 的舊資料
及名稱文字 escaping；`e2e/agent-flows.spec.ts` 的 saved input sources 案例以受控
main→renderer 內部 user payload 驗 UI／IndexedDB／Default View reconnect，並不驗
live Telegram。D1 的真 app-tool／內部 Sender 路徑由 `agent-delegation.spec.ts` 驗
派工作與人工提取結果的雙端來源標示。

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

## File Diff verification

`src/shared/agent-diff.test.ts` 驗 legacy／hunks body 及完整範圍驗證；Codex 的
`file-changes.test.ts` 與 `app-server-translate.test.ts` 驗 unified parser、逐檔 ID、
混合 fallback、原文完整性、遮罩與診斷。`codex/index.test.ts` 以 FakeAppServer 驗
正式 started／completed 經真正 forwarding loop 發出每張卡片。Remote、renderer
message-builder 與 agent-history unit 覆蓋跨層投影、非法 body fail-visible、同 ID
upsert 與舊資料相容。

`npm run test:e2e -- e2e/codex-provider-flow.spec.ts` 以 fake provider 將受控
fileChange fixture 送進正式 translator，再走 wire／renderer／IndexedDB。案例涵蓋
Markdown Expanded 與 File Diff Collapsed 的獨立設定、每檔收合、多 hunk 行號、
重複通知、混合 fallback、failed／declined、重連歷史還原與 legacy body。
這些測試不呼叫 live Codex，不證明真實模型或 app-server transport 的操作結果。
