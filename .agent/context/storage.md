---
type: context
title: Storage
related:
  - contracts/persistence-formats
  - context/pm-agent
---

# Storage

> Per-project 檔案產物統一收在 `projects/<id>/`，Notes 圖片走 file storage + auto-GC。

## storage#1 — Per-project storage 統一在 `<userData>/projects/<id>/`  ·  [Decision]

**Decision**：所有 per-project 的檔案產物都放在 `<userData>/projects/<projectId>/` 底下（PM project note、user-facing notes、note 圖片資料夾、未來新功能…）。Project 移除時 `removeProjectStorage(id)` 一行 `fs.rm` 整包清掉。

**Reason**：
- 之前 PM note 自己一個 top-level `pm-notes/<id>.md` 目錄，且 project 移除時根本沒清——orphan 檔案累積
- 新功能（Notes, 之後可能有更多）每個都自選位置 = 每加一個就要記得改 removeProject 邏輯，必然會漏
- 改成統一目錄後，新加 per-project feature 只要寫進 `projectDir(id)`，移除是免費的
- ProjectId 不會跨 instance 共用，加上層 `projects/` 資料夾不會跟 sessionId-keyed 的東西（agent context）混

**Mechanism**：
- `src/main/project-storage.ts` 提供 `projectDir(id)` / `ensureProjectDir(id)` / `removeProjectStorage(id)`
- `src/main/migrations/migrate-pm-notes.ts` 啟動時 idempotent 搬家：copy → verify → unlink，partial run 安全 resume
- `IPC.PROJECT_SAVE` handler 比較 old/new id set，刪掉的 id 觸發 `removeProjectStorage`

**Out of scope**：
- Agent context（`~/.shelf/agent-context/{sessionId}.json`）跟 IndexedDB agent UI history 是 sessionId-keyed 不是 projectId-keyed，多 session 共用一個 project，硬塞進來反而扭曲關係——維持現狀
- App-global 檔案（settings、pm-history、pm-global-note、ssh-servers、logs）不要動

**Do not change casually because**：
- 不要在新 per-project feature 自己 `<userData>/foo-<id>.md`，直接用 `projectDir(id)`
- 不要在 PROJECT_SAVE handler 之外另起 cleanup 路徑——單一進入點才不會漏

## storage#2 — Notes 走 file storage + auto-GC，不用 base64 inline  ·  [Decision]

**Decision**：使用者貼進 Notes panel 的圖片存成獨立檔案（`projects/<id>/images/<uuid>.<ext>`），markdown 引用 `![](images/<uuid>.png)`。每次 `writeNote` 掃 markdown 抓 ref，刪掉沒被 ref 的 image 檔。Renderer 透過 `shelf-image://<projectId>/<filename>` custom protocol 讀圖。

**Reason**：
- Base64 inline 看似省事（刪文字 = 圖片自然消失，無生命週期），但 1MB 截圖→1.4MB 文字，5–10 張就讓 textarea / marked render 卡爆
- File + auto-GC 用 ~15 行 regex scan 達到「刪 ref → image 檔自動消失」一樣的體感，且 .md 維持純文字幾 KB
- `shelf-image://` 比 `file://` 更安全：在 main 端做 segment 驗證（拒絕 `..` / `/`），不暴露任意 file system 讀取

**Mechanism**：
- `src/main/notes-store.ts` 的 `writeNote` 內呼叫 `garbageCollectImages` (regex `/images\/([\w.-]+)/g`)
- `src/main/notes-protocol.ts` 用 `protocol.handle()` (Electron 25+ 新 API)，scheme 在 `whenReady` 前 `registerSchemesAsPrivileged({ standard, secure, supportFetchAPI })`
- Renderer paste handler 抓 image MIME → IPC `notes:save-image` → 拿 ref 插入游標處
- Preview 渲染前用 regex rewrite `images/x` → `shelf-image://<id>/x`（marked 的 `![](images/x)` 跟 raw `<img src>` 兩種都處理）

**Do not change casually because**：
- 不要為了「不留垃圾」做嚴格 cleanup（每次 paste 都檢查全部 ref）— 太緊會誤刪正在編輯但還沒寫回的引用；目前 GC 只在 `writeNote` 觸發，跟磁碟 state 強同步
- 不要切到 base64「就一兩張小圖沒差」— 一旦 user 貼一張全螢幕截圖就崩，沒回頭路
