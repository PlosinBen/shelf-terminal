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
