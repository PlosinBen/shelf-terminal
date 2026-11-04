---
type: map
title: Preserved spike and reevaluation branches
---

# Spike Archive

此索引記錄必須保留的 spike／重評備份分支與原始驗證 artifacts，避免移除 worktree 後，
被當作一般已完成 feature branch 清理。內容不代表已採用的產品架構。

## 保留規則

- **不得自動刪除下列分支**，即使已無 worktree，或 spike 已停止。
- 刪除前須確認報告、測試、鎖檔與 evidence 已另行封存並可讀取，更新本索引，
  且取得使用者明確確認；不能只因結果已摘要到其他文件就刪除原始證據。
- 本索引是操作規範，不是 Git 防刪保護。保留本機分支不等於遠端備份；
  push、建立 tag 或其他封存動作仍需另行授權。
- 恢復 code／test 驗證仍依 development-flow 與 Shelf worktree handoff，
  不在 main checkout 實作，也不以封存分支存在視為重新開工授權。

## Rust desktop／Tauri feasibility

| 欄位 | 內容 |
|---|---|
| 保留分支 | `spike/rust-gui-interaction-validation` |
| 封存基準 commit | `f6d5359fb9a30c56c5823a4d65210bc13e9edda2` |
| 狀態 | Worktree 已移除，分支保留；Rust 遷移暫緩，維持 Electron |
| 保存內容 | egui 互動與 PTY ownership 比較；Tauri browser/session、雙向 cookie 池、Domain identity 與 browser_fetch 請求架構驗證 |
| 保留原因 | 原始 prototype、可重跑測試、鎖檔與失敗證據未整合進 main，供未來重評與避免重複調查 |
| 備份狀態 | 登錄時僅確認本機分支存在，未見包含此 tip 的本機 remote-tracking ref；未驗證遠端實際狀態，不視為已備份 |

下列路徑均位於**封存 commit／分支**，不是 main checkout 的現有路徑：

| 想查什麼 | 封存路徑 |
|---|---|
| egui 互動、焦點／快捷鍵、真實 PTY 與 Web 比較 | `spikes/rust-gui-interaction/README.md` 與同目錄 prototype／tests／鎖檔 |
| Tauri 各輪結果與重跑命令 | `spikes/tauri-browser-session/README.md` |
| browser_fetch 候選矩陣、契約與維護成本 | `spikes/tauri-browser-session/request-architecture.md` |
| 原始 session／Path scope 失敗 | `spikes/tauri-browser-session/evidence.json` |
| 雙向 cookie 池／更新順序 | `spikes/tauri-browser-session/pool-evidence.json` |
| Domain／host-only 原生身分對照 | `spikes/tauri-browser-session/domain-evidence.json` |
| 公開 WKDownload 請求與 body 遺失證據 | `spikes/tauri-browser-session/request-evidence.json` |
| 完整重跑材料 | `spikes/tauri-browser-session/` 的 fixtures、runners、native prototype、package／Cargo lockfiles |
| 現有 TerminalView remount 重複 spawn 的重現 | `e2e/rust-gui-comparison.spec.ts`；該分支的 `.agent/context/terminal-pty.md` 中 terminal-pty#13 |

### 結論邊界

- egui 最小比較不證明完整原生 GUI 更簡單；session owner 與 view lifetime
  分離是 Web 也能採用的設計，不是 Rust 獨有收益。
- macOS 有界 cookie 池雙向讀寫可行；Domain 身分需要 Foundation 建構補充。
  原 copy-cookie transport 的 `COOKIE_SCOPE_BLOCKER` 仍保留失敗。
- 公開 WKDownload 路徑可沿用引擎 session，但在實測 macOS 14.1.1／WebKit
  19616.2.9.11.7 下，request body 由建構時 15 bytes 變成 server 收到 0 bytes，
  `REQUEST_BODY_BLOCKER` 仍失敗。F1 整體未通過，沒有進入 F2。
- 這些是否定指定環境／候選路徑的證據，不代表所有 Tauri／WebKit 版本永遠
  不可行；真實 SSO／MFA、跨平台及完整遷移效益仍未驗證。

### 不恢復 worktree 即可查閱

```sh
git show f6d5359fb9a30c56c5823a4d65210bc13e9edda2:spikes/tauri-browser-session/request-architecture.md
git ls-tree -r --name-only f6d5359fb9a30c56c5823a4d65210bc13e9edda2 spikes/
```

Commit hash 只是定位資訊，並非防刪備份；仍須保留可到達該 commit 的 Git ref。

## Agent message channel 重評來源

| 欄位 | 內容 |
|---|---|
| 保留分支 | `backup/agent-message-channel-before-reevaluation` |
| 封存基準 commit | `4f908d762c1330580853d456a982e55c91409b2c` |
| 保存內容 | 追上 main 前的原始 branch 實作與 27 個相對當時 main 的 commits，供逐功能取捨後查閱原方案 |
| 保留原因 | 重評採用的是調整後的功能與資料模型；原始方案未整批合入，不能以新 branch 完成視為可刪除 |
| 刪除條件 | 先確認原始 code／tests 已有可讀取的替代封存，更新本索引，且取得使用者明確同意；不因功能重評完成、合併或移除 worktree 自動刪除 |
| 備份邊界 | 已確認本機 ref；未驗證遠端備份，不以本機保留推論已上傳。push／tag 仍需另行授權 |

不需恢復 worktree 即可用 `git show backup/agent-message-channel-before-reevaluation:<path>`
查閱原始檔案；封存內容不代表目前產品契約。
