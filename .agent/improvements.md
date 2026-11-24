---
type: reference
title: Shelf — 待評估改善項目
---

# 待評估改善項目

記錄值得接續評估的問題，不代表已採納方案或授權實作。依 feedback-discipline 在相關工作、問題重現或約定條件成立時查閱，不逐回合提醒。此清單只收 Shelf 專案項目；共用 skill 問題應回到其可維護來源。

已確認並完成的項目移出清單；必要現況與理由歸入對應永久文件。沒有實際重複證據的項目，不標為重複失誤。

## IMP-1 — Docker／SSH 測試 wrapper 可能掩蓋失敗

- 狀態：待評估。
- 問題與證據：[package.json](../package.json) 的 `test:docker`／`test:ssh` 在 build／測試鏈後以分號接 `docker rm -f`。依 shell exit-status 語意，清理成功可能使整個 script 回傳 0，即使前段失敗；目前是來源檢閱發現，未執行產品失敗重現，亦未確認有多次誤報案例。
- 影響：只依 wrapper exit code 可能誤判通過；執行時仍需讀完整輸出。現有邊界見 [verification.md](verification.md)。
- 建議落點：測試 scripts 的退出狀態與 cleanup；先以隔離 probe 重現前段失敗／清理成功的組合，再評估最小修改與回歸檢查，不直接啟動容器或改 script。
- 再檢視條件：修改這兩個 scripts、執行相應測試，或發現 wrapper 成功但測試輸出失敗時。

## IMP-2 — Electron E2E 失敗證據的產生與保存尚未確認

- 狀態：待評估。
- 問題與證據：[playwright.config.ts](../playwright.config.ts) 同時設定 `retries: 0` 與 `trace: 'on-first-retry'`；[共用 fixture](../e2e/helpers.ts) 自行啟動 Electron／取得 page，並在 teardown 刪除 userData。不能由自動 screenshot 設定推論實際附圖，也不能期待 teardown 後仍有 app log。尚未實跑確認 artifact 行為，沒有宣稱曾發生多次證據遺失。
- 影響：失敗後可能缺少定位資訊，或 agent 需要再次重現才能取得；實際影響範圍仍待執行確認。
- 建議落點：驗證 harness／artifact 保存；先在隔離測試環境製造可控失敗，檢查 trace、截圖與 log，再依缺口選必要修改。若需改 fixture／測試，依 repo worktree 規則進行。
- 再檢視條件：修改 Playwright／fixture／證據流程，或需要依賴 E2E artifact 定位失敗時。

## IMP-3 — Codex 回答的 moderation/display 尚未處理

- 狀態：接受現況、暫不實作；保留回檢。完整呈現機制不作為升版前置條件。
- 問題與證據：[Codex translator](../agent-server/providers/codex/app-server-translate.ts) 直接轉送回答文字，未消費上游 moderation/display；觸發範圍及實際影響尚未驗證。現行決策、契約邊界與來源見 [agent-providers#57](context/agent-providers.md)。
- 影響：若收到指定回答的隱藏、替代或封鎖指示，Shelf 仍沿用原文字呈現；不代表工具授權或既有錯誤處理失效。
- 建議落點：Codex provider 的訊息轉換與診斷；先以無害 fixture 確認適用語意與缺口，再評估最小處理。若實作，須覆蓋串流、完成、持久化與重開，不先引入完整 Chat 介面。
- 再檢視條件：後續 Codex 升版、修改回答或歷史處理；收到實際 moderation/display payload、相關呈現問題，或上游明確第三方責任／契約變更。回檢不等於自動授權實作，也不因普通對話測試通過而結案。

## IMP-4 — Copilot 在 Alpine arm64 的 standalone CLI 無法啟動對話

- 狀態：使用者同意暫緩；保留既有問題，不作本輪 SDK 升版與主要功能交付的阻擋。
- 問題與證據：CLI1.0.103 與1.0.114 的 linuxmusl-arm64 standalone 都在 native bootstrap 失敗，`--version` 成功不足以證明可用。Debugger 捕捉到 cli-native.node 初始化查找 Node-API symbol 回 null；ELF GNU hash 無法查到所需 API。同一份解出的 CLI 由系統 Node 啟動，提供 Bash 後，隔離 ACP 模型 fixture 的停止／恢復通過。現況邊界見 [agent-providers#9](context/agent-providers.md)。
- 影響：已重現於 Alpine arm64 的 Copilot 對話，非本次升版新增的已知回歸；不外推至所有 musl 架構，也不代表 Claude 的 Alpine 路徑或整個 Shelf 不支援 Alpine。
- 建議落點：優先驗證上游修復的 standalone artifact。未採用解包後改系統 Node 啟動的 workaround，也不配送手動改寫 ELF 的 binary；暫存 GNU hash 重建實驗未得到可用修復。
- 再檢視條件：上游發布相關修復、有實際 Alpine 使用需求，或準備調整 musl 支援範圍時。重新驗證須包含 ACP initialize、新對話、工具執行與停止後恢復，不只執行版本指令。

## IMP-5 — Copilot 載入原對話後的 Shelf 工具搜尋偶發空結果

同一個 session 在 Stop 前後以相同範圍 `shelf` 和關鍵字 `skill` 搜尋，曾從 7 個工具變成空清單。後續測試在恢復後成功直接呼叫已找到的工具，該回合沒有新的搜尋結果可供比對。維持待觀察。

再次出現時，依 [MCP 診斷說明](verification.md) 對照同一回合的 `tool_search_output` 與 Shelf 最近的 `tools/list` 回應，確認 `update_app_skill` 在哪一層消失。
