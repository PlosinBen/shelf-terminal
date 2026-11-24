# CLAUDE.md

Begin every user-facing final reply in natural language with `Ben,`. If the requested output format requires an exact response, follow that format.

## Agent Reference Docs

修改子系統前，依任務從 [.agent/index.md](.agent/index.md) 查閱相關主題文件，也可依下表直接前往：

| Situation | Read |
|-----------|------|
| 找功能在哪個檔案 | [.agent/map.md](.agent/map.md) |
| 理解系統結構 / 抽象資料流 | [.agent/architecture/index.md](.agent/architecture/index.md) |
| 查介面規格 / 訊息格式 / 路由規則 | [.agent/contracts/index.md](.agent/contracts/index.md) |
| 理解為什麼這樣設計、什麼不該改、debug 前先看 | [.agent/context/index.md](.agent/context/index.md) — decisions + gotchas 按 topic；code 以 `<topic>#N` 引用（如 `skills#4` → `context/skills.md` 第 4 條）|
| 評估新 feature 該不該做、判斷是否偏離產品定位 | [.agent/PRODUCT.md](.agent/PRODUCT.md) |
| 選擇驗證、查環境前提、證據位置與覆蓋限制 | [.agent/verification.md](.agent/verification.md) |
| 查相關工作的已知改善提案與再檢視條件 | [.agent/improvements.md](.agent/improvements.md) — 待評估清單，不等於已採納或授權實作 |
| 發版流程、tag 規範 | [.agent/RELEASE_FLOW.md](.agent/RELEASE_FLOW.md) |
| 查封存 spike 成果／清理分支前確認保留限制 | [.agent/SPIKE_ARCHIVE.md](.agent/SPIKE_ARCHIVE.md) — 已移除 worktree 的保留分支、證據位置與刪除條件 |
| 追蹤「必要回檢」的上游 issue（我方有 workaround/退化、等上游修好回收） | [.agent/UPSTREAM_WATCH.md](.agent/UPSTREAM_WATCH.md) — 薄 index，每次 release 前回檢（綁在 RELEASE_FLOW step 0.6）；rationale 仍在 `context/<topic>` |
| 開發中 feature 的暫存工作筆記 | [.agent/features/](.agent/features/) — **development-flow** skill 的 transient note（PRD/SDD/Spec/Tasks），收尾 consolidate 進永久 doc 後刪除；**非永久文件**（gitignored、不跨機器同步）|

### Documentation maintenance
開發流程依 **development-flow**；文件維護依 **project-agent-docs**；驗證依 **verification-discipline**，專案能力見 [.agent/verification.md](.agent/verification.md)；Git 交付依 **git-change-handoff**；文件格式依 **open-knowledge-format**。

零星改動則直接更新 `.agent/`：**新增/搬移模組** → `map.md`（intent → file + 一行 role）；**改資料流** → `architecture/<topic>.md`（抽象、不提檔名）；**介面/訊息變更** → `contracts/<topic>.md`；**新決策或 gotcha** → 對應 `context/<topic>.md`（append 下一個 `topic#N`，從 code 以 `<topic>#N` 引用）。context entry 寫**現況 + 為什麼**，不留 changelog / 已廢棄 feature / commit hash / 日期。

## Rules

- **跨功能降級原則**：可用性可以降級，安全與資料正確性的必要條件不可放寬。停止受影響操作，保留能獨立、安全運作的功能；明確呈現失敗，不繞過認證／授權／驗證、不靜默丟資料、不把失敗標示成功。見 `.agent/context/failure-handling.md`（failure-handling#1）。
- Bug fix 依 **systematic-debugging**，須先用迴歸測試重現問題，再修正。
- **開發中，每次修正跑能驗證該行為的最小測試。Feature 或 bug fix 收尾前，在最終版本跑型別檢查、完整 unit suite，以及涵蓋變更與受影響既有流程的 E2E。**
- **Renderer 行為變更須同批新增或更新對應的 E2E，並執行受影響的 spec。** 所需環境不可用時，完成其餘可獨立執行的檢查，並回報未驗證的行為與具體阻礙。沒有可供 E2E 驗證的 core／非 UI 邏輯以 unit test 為主。
- 不要直接啟動 dev server 或 Electron。驗證使用專案的 npm scripts，執行方式與環境前提見 [.agent/verification.md](.agent/verification.md)。
- Commit 前確認 `.agent/` 是否需要更新（規範見上方「Documentation maintenance」）— 有新增功能、改變架構、或發現 gotcha 時一併更新
- `.agent/features/` 是暫時開發 context（gitignored、不跨機器同步）— **程式碼 / 測試 / 永久 doc 絕對禁止引用它**
- 採用足以滿足當前需求的最簡單設計，改動限於本次任務所需。
- 跨檔共用的識別值，例如事件名、IPC channel 或 wire kind，應在一處定義為具名常數，由產生端和消費端共用。
- 讀取或修改檔案時，優先使用目前 agent 提供的原生檔案工具。只有需要依資料結構解析或轉換內容時，才考慮使用腳本。
- 執行彼此獨立的命令時，分開呼叫工具，避免用 `;` 串接，讓 Shelf 分別顯示每個命令的結果。後一步需要前一步成功時，才用 `&&` 串接。若查無結果符合預期，只將該工具代表「查無結果」的退出碼視為正常，其他錯誤仍回傳原退出碼。
- 需要 dev 整個重 build 才能驗的項目（如 agent-server bundle 改動），先把所有相關項目一口氣做完再交給 dev 驗一輪 — 不要做一個交一個，造成來回重 build 浪費時間
- 禁止靜默吞錯 / 丟資料 — 狀態對不上、解析失敗、收到非預期輸入時要 fail-loud（log 出關鍵 id / context），不要 silent `return` 或 catch 後不處理。良性 race 用低調 log（`debugLog` 落檔）、真資料遺失要大聲（`console.warn/error`）；純函式回傳 anomaly 讓 caller log（保持可測）。樂觀更新尤其要在跟真相源對帳對不上時留痕
- **Worktree-first development**（覆寫 development-flow「原地開 branch」預設）：
  - **Code / tests 一律在 worktree 開發** — 不在 main checkout 改 tracked source/test。main checkout = 規劃 + 唯讀調查 + 純文件維護 + 純套件升級；若升級後測試有問題，則開 note 並依 development-flow 處理。
  - **純文件維護（不伴隨 code 變更）可在 main checkout 直接改**：`.agent/`、CLAUDE.md、其他 markdown、`.agent/features/` note。
  - **伴隨 code 變更的 doc 跟著 code 走**：一次 code 變更該連帶更新的 `.agent/` / contract / map，與那份 code 同在 worktree、同批改，不拆回 main。
  - 對本 repo 中必須隔離的 code / test work，**必須**以 `shelf-worktree-handoff` 作為控制流程；**禁止**繞過它自行建立 worktree，或留在 parent project 實作。該 skill、development-flow 或必要 Shelf worktree tools 任一缺失時，**必須立即停止並明確回報，禁止降級或自行補做整合流程**。純文件維護仍依本 repo 的明文例外處理。
