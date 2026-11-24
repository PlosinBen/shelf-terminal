# CLAUDE.md

Begin every user-facing final reply in natural language with `Ben,`. If the requested output format requires an exact response, follow that format.

## Agent Reference Docs

修改子系統前，依任務從 [.agent/index.md](.agent/index.md) 查閱相關主題文件，也可依下表直接前往：

| 何時查 | 文件 |
|---|---|
| 找功能或模組的位置 | [.agent/map.md](.agent/map.md) |
| 理解架構、資料流或系統邊界 | [.agent/architecture/index.md](.agent/architecture/index.md) |
| 查介面、訊息格式或路由 | [.agent/contracts/index.md](.agent/contracts/index.md) |
| 查設計理由、既有約束或已知問題 | [.agent/context/index.md](.agent/context/index.md) |
| 評估需求是否符合產品定位 | [.agent/PRODUCT.md](.agent/PRODUCT.md) |
| 選擇驗證方式、查前提或覆蓋範圍 | [.agent/verification.md](.agent/verification.md) |
| 查待評估的改善提案與回檢條件 | [.agent/improvements.md](.agent/improvements.md) |
| 查發版流程與 tag 規範 | [.agent/RELEASE_FLOW.md](.agent/RELEASE_FLOW.md) |
| 查封存成果或清理分支前確認限制 | [.agent/SPIKE_ARCHIVE.md](.agent/SPIKE_ARCHIVE.md) |
| 發版前回檢上游問題 | [.agent/UPSTREAM_WATCH.md](.agent/UPSTREAM_WATCH.md) |
| 接續進行中的開發 | [.agent/features/](.agent/features/) |

### Documentation maintenance
開發流程依 **development-flow**；文件維護依 **project-agent-docs**；驗證依 **verification-discipline**，專案能力見 [.agent/verification.md](.agent/verification.md)；Git 交付依 **git-change-handoff**；文件格式依 **open-knowledge-format**。

變更若影響模組位置、資料流、介面或設計決策，或發現需要記錄的 gotcha，須同批更新對應的 `.agent/` 文件。

## Rules

- **失敗處理**：必要前提不成立時，停止受影響的操作，保留能獨立且安全運作的功能。維持認證、授權、驗證與資料正確性的要求，明確呈現失敗。診斷規則見 [failure-handling#1](.agent/context/failure-handling.md)。
- Bug fix 依 **systematic-debugging**，須先用迴歸測試重現問題，再修正。
- **開發中，每次修正跑能驗證該行為的最小測試。Feature 或 bug fix 收尾前，在最終版本跑型別檢查、完整 unit suite，以及涵蓋變更與受影響既有流程的 E2E。**
- **Renderer 行為變更須同批新增或更新對應的 E2E，並執行受影響的 spec。** 所需環境不可用時，完成其餘可獨立執行的檢查，並回報未驗證的行為與具體阻礙。沒有可供 E2E 驗證的 core／非 UI 邏輯以 unit test 為主。
- 不要直接啟動 dev server 或 Electron。驗證使用專案的 npm scripts，執行方式與環境前提見 [.agent/verification.md](.agent/verification.md)。
- `.agent/features/` 是暫時開發 context（gitignored、不跨機器同步）— **程式碼 / 測試 / 永久 doc 絕對禁止引用它**
- 採用足以滿足當前需求的最簡單設計，改動限於本次任務所需。
- 跨檔共用的識別值，例如事件名、IPC channel 或 wire kind，應在一處定義為具名常數，由產生端和消費端共用。
- 讀取或修改檔案時，優先使用目前 agent 提供的原生檔案工具。只有需要依資料結構解析或轉換內容時，才考慮使用腳本。
- 執行彼此獨立的命令時，分開呼叫工具，避免用 `;` 串接，讓 Shelf 分別顯示每個命令的結果。後一步需要前一步成功時，才用 `&&` 串接。若查無結果符合預期，只將該工具代表「查無結果」的退出碼視為正常，其他錯誤仍回傳原退出碼。

## Worktree-first

修改 source 或 tests 必須在 Shelf worktree 內進行。尚未進入對應 worktree 時，先走 `shelf-worktree-handoff`。

- **Main checkout** 可用於規劃、唯讀調查、純文件維護，以及只改依賴宣告和 lockfile 的套件升級。純套件升級可在 main 執行既有測試。
- **套件升級後測試失敗**時，建立工作 note 並依 `development-flow` 處理。若需修改 source 或 tests，先走 Shelf handoff。
- **隨 code 變更的文件**與 code 放在同一個 worktree，同批交付。
- **缺少 `shelf-worktree-handoff`、`development-flow` 或必要的 Shelf 工具**時，立即停止需要隔離的工作並回報阻礙。Worktree 的建立、接續和收尾一律走 Shelf handoff。
