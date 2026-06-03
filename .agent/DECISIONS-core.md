# DECISIONS — Core Infrastructure

Electron 基礎建設、connector 抽象、persistence、settings、檔案上傳、shell 相關決策。

編號保持歷史穩定（缺號表示已淘汰、併入 CLAUDE.md Conventions 或併入其他 decision）。跨檔 cross-ref 用 `DECISIONS #N` 直接 grep，編號全域唯一。

---

## 2. Connector 抽象層（Factory Pattern）

**決策**: `src/main/connector/index.ts` 的 `createConnector(connection)` 根據 connection type + OS 回傳對應實作。IPC handler 呼叫 factory 取得 connector 再操作。Preload 只是 RPC bridge，不含 dispatch 邏輯。

**原因**: 所有 connection-specific 邏輯（spawn、listDir、upload、cleanup）收在各自的 connector 實作裡，消費端（pty-manager、file-transfer、IPC handler）不需要 switch connection type。新增 connection type 只需加一個 connector 檔案 + 註冊到 factory。

**不要改**: 如果把 connection dispatch 散回各消費端，每個用到 spawn/listDir/upload 的地方都要重複 switch。

---

## 4. SSH ControlMaster Multiplexing

**決策**: SSH 連線使用 `ControlMaster=auto` + `ControlPersist=600`，同 project 多個 tab 共用 TCP 連線。

**原因**: 避免每開一個 tab 都重新認證和握手。600 秒 persist 讓短暫斷開的 tab 不需要重連。

**不要改**: 不用 ControlMaster 的話每個 tab 獨立 SSH 連線，開 5 個 tab = 5 次認證。

---

## 7. userData 隔離靠 Electron 內建訊號

**決策**: `src/main/user-data-path.ts` 的 `applyUserDataIsolation()` 在 `index.ts` top-level 呼叫一次（idempotent guard）。判斷邏輯：
- `app.isPackaged === true` → packaged 安裝版 → 保留 OS-default 路徑（prod）
- `app.commandLine.hasSwitch('user-data-dir')` → E2E tempdir 自己指定 → 不動
- 其他（dev、`npx electron .`、`npm run pack`）→ OS-default 路徑加 `-dev` 後綴

E2E 測試在 `e2e/helpers.ts` 每個 worker `mkdtempSync` 一個 tempdir，啟動帶 `--user-data-dir=<tempdir>`，結束 `rm -rf`。**NODE_ENV 不參與 userData 決策**。

**原因**: 舊版靠 `NODE_ENV` 當 gate，本地 `npx electron .` / `npm run pack` 沒帶就寫進正式 userData（v0.5.0 `projects.json` 遺失事件）。`app.isPackaged` 是 Electron 原生訊號，packaged runtime 直接讀，不需要 build-time inline。Safe-by-default：任何 unpackaged 啟動都自動掛 `-dev`。

**不要改**:
- 把 gate 換回 `NODE_ENV` → 回到 v0.5.0 bug
- 把 fallback 拿掉變成「isPackaged 以外都寫 OS-default」→ safe-by-default 失效
- 把 `applyUserDataIsolation()` 搬進 `whenReady` → 晚於 Electron 內部初始化（Cookies、Cache），部分資料寫錯路徑
- E2E 改回 `NODE_ENV=test` 推算路徑 → worker 無法併行、會刪到 dev userData

---

## 8. Settings Shallow Merge with Defaults + Deep Merge Keybindings

**決策**: `loadSettings()` 用 `{ ...DEFAULT_SETTINGS, ...saved }` merge，新增 setting key 時舊的 settings.json 自動補預設值。`keybindings` 額外做 deep merge（`{ ...DEFAULT_KEYBINDINGS, ...saved.keybindings }`），確保新增的快捷鍵不會被舊設定覆蓋掉。

**原因**: 向前相容。用戶升級版本後不需要手動加新欄位。keybindings 是巢狀物件，shallow merge 會讓舊存檔整個覆蓋 defaults，導致新快捷鍵消失。

**不要改**: 如果直接讀 saved 不 merge，舊版 settings.json 缺少新欄位會 crash。如果 keybindings 不 deep merge，每次新增快捷鍵都要手動刪 settings.json 才能生效。

---

## 12. TerminalView 是唯一 spawn 點

**決策**: 只有 `TerminalView` 的 useEffect mount 時呼叫 `pty.spawn`。Event handler（NEW_TAB、CONNECT_PROJECT）只負責 `addTab()`。

**原因**: 之前 event handler 和 TerminalView 都 spawn，導致每個 tab 被 spawn 兩次。

**不要改**: 如果在 event handler 也 spawn，會跟 TerminalView mount 重複。

---

## 13. 檔案上傳統一走 `<cwd>/.tmp/shelf/`，不用 `/tmp/shelf-paste`

**決策**: 所有 paste / drag-drop 上傳的目的地都是 `<projectCwd>/.tmp/shelf/<prefix>-<filename>`，而不是過去的 `/tmp/shelf-paste/`。Local / SSH / Docker / WSL 共用同一個 `connector.uploadFile` 入口。

**原因**:
- 沙盒過的 agent CLI（Claude Code、Gemini、Codex）只能讀 project 內的檔案，丟到 `/tmp` 它會回 permission denied。
- 路徑跟著 project 走，不會在 `/tmp` 留下跨 project 的孤兒檔。
- `.tmp/` 慣例上 git-ignorable，使用者可以一鍵清掉。

**不要改**: 換回 `/tmp` 會直接打破 sandboxed agent 的使用情境。

---

## 14. 上傳一律 cat-via-stdin，不用 scp / docker cp

**決策**: SSH / Docker / WSL 三種 transport 在 `file-transfer.ts` 都用同一個 pattern：
`spawn('<bin>', [...args, 'sh', '-c', "mkdir -p '<dir>' && cat > '<path>'"])` 然後把 buffer 灌進 stdin。

**原因**:
- **不用 staging file** — 不再需要先寫 `os.tmpdir()/shelf-paste/xxx` 再傳出去，也不會有 staging 漏掉沒清的問題。
- **不用 scp 的 remote-shell 解析** — scp 在遠端會把路徑跑過一次 shell，filename 含空白／引號就會炸；改用 `cat >` 後路徑只經 single-quote 一層。
- **三種 transport 對稱** — 同一個 helper（`spawnPipeWrite`）三邊複用，新增 transport 只要再寫一個 wrapper。

**不要改**: 退回 scp 會把 staging cleanup、cross-shell quoting、binary safety 三個雷一次踩回來。

---

## 16. Bootstrap 在開窗前先載入 config，失敗時 blocking dialog

**決策**: `app.whenReady()` 裡先呼叫 `bootstrap()` 同步載入 `projects.json` 和 `settings.json`，再 `createWindow()`。`loadProjects` / `loadSettings` 回傳 `LoadResult` discriminated union（`ok | parse | permission | read`），bootstrap 根據錯誤型別跳對應的 `dialog.showMessageBoxSync`：parse 給「Quit / Backup & Continue」、permission/read 只給 Quit。

**原因**:
- 過去 config 損毀時 silent 退回 default，使用者不會意識到自己的 project 列表「不見了」直到下次儲存覆寫。
- Sync dialog 在 ready 階段是少數能 block 的時機；window 都還沒開，視覺上不會看到半成品的 UI 又跳錯。
- E2E 測試用 `SHELF_BOOTSTRAP_DIALOG_RESPONSE=quit|continue` env 變數 mock dialog 回應，避免測試卡在 native 對話框。

**不要改**: 把 dialog 推到 createWindow 之後 / 用 async dialog 會讓 race condition 變多（renderer 已經跟 main 要 cachedProjects 但 cache 還沒填）。

---

## 18. App 快捷鍵在 Capture Phase 攔截 + stopPropagation

**決策**: `useKeybindings` 在 window capture phase 監聽 keydown。匹配到已註冊的快捷鍵後執行 action 並 `preventDefault` + `stopPropagation`，事件不會到達 xterm。

**原因**: xterm 會攔截大部分鍵盤事件（包括 Ctrl+D、Ctrl+T 等）。用 capture phase + stopPropagation 確保 app 快捷鍵優先於 xterm。新增快捷鍵只需在 types + defaults + useKeybindings 註冊，不需要改 TerminalView。

**不要改**: 如果讓 xterm 先收到事件再判斷要不要放行，每新增一個快捷鍵都要同步改 TerminalView 的 `attachCustomKeyEventHandler`。

**例外**: Windows/Linux 的 Ctrl+V（paste）和 Ctrl+C（copy when selected）不是 app 快捷鍵，是瀏覽器原生行為。這兩個在 TerminalView 的 `attachCustomKeyEventHandler` 裡 return false 讓瀏覽器處理。

---

## 19. 上傳清理：session-based、cutoff 從檔名解出來

**決策**: `<cwd>/.tmp/shelf/` 清理走兩條路：
- **自動**：project 在 Shelf process 內第一次 spawn pty 時，`maybeScheduleCleanup()` 排 3 秒後 fire-and-forget cleanup。同 project 在 process 內只跑一次（`cleanedProjects` Set 去重）。Cutoff 是 `SESSION_STARTED_AT`（process 啟動時 ms），比這個舊的刪。
- **手動**：ProjectEditPanel 的 Clear 按鈕無視時間戳直接清空。

過期判斷從**檔名解出**：upload prefix 是 `Date.now().toString(36) + counter`，`parseUploadPrefix()` 反解回 ms，不依賴 mtime。

**原因**:
- `find -mmin` 解析度是「捨入到下一分鐘」，會誤刪剛 paste 的檔。Filename-encoded ts 精確到 ms
- 四種 transport 只需要 `ls` + `rm`，不需要 `find` / `stat`
- `parseUploadPrefix` 對非 Shelf prefix 回 `null`，user 自己的檔不會被掃
- Fire-and-forget + 3 秒延遲讓 first paint 不被 cleanup 卡到，錯誤只 log 不 throw

**不要改**:
- 換回 mtime cutoff → 踩 `find -mmin` 捨入問題
- Cleanup `await` 在 spawn 之前 → 遠端 exec 延遲直接打到開 tab 時間
- 拿掉 dedupe → 每次 spawn 都重跑 cleanup，浪費 SSH/docker exec

---

## 19b. Worktree 是獨立 Project

**決策**: Git worktree 以獨立 project 存在於 sidebar、透過 `parentProjectId` 關聯，繼承 parent 的 connection 設定。Worktree path 放在 parent cwd 的同層目錄（`<parentDir>/<projectName>-<branchName>`，非 repo 內部以避免 `.gitignore` 排除）。

**不要改**: 不要把 worktree 做成 project 子層級 — sidebar 要從 flat list 變 tree，拖曳排序邏輯複雜化。

---

## 20. Connector exec() 方法

**決策**: `Connector` 介面加 `exec(cwd, cmd)` 方法，用於在目標環境執行非互動式指令（如 git 操作）。各 connector 實作對應的 execFile 呼叫。Git IPC handler 透過 connector.exec() 執行，不直接暴露 exec 到 renderer。

**原因**: git worktree 操作需要在遠端（SSH/Docker）執行指令，透過 connector 抽象層可以統一處理，不需要針對每種 connection type 寫不同的 git 邏輯。只暴露特定 git IPC channel 而非通用 exec，避免安全風險。

**不要改**: 不要在 preload 暴露通用 exec API。

---

## 21. Branch 切換用 connector.exec()，Worktree branch 跳轉而非 checkout

**決策**: branch 切換用 `connector.exec('git checkout')`，前置用 `git status --porcelain` 檢查 dirty 狀態。Worktree-occupied branch 點擊跳轉到對應 project（或自動建立），不嘗試 checkout。

**原因**: Worktree branch 不能 checkout（git 限制）。用隱藏 tab 跑 git 指令的話 shell exit code 不可靠。

**更新（footer 重設計後）**: BottomBar 的 branch **顯示/dropdown UI 已移除**（更新時機不可靠：每次讀都 shell out 到 connector，SSH/Docker 慢且切換後無可靠 refresh 時機）。但**切換 side-effect 邏輯休眠保留** — `SWITCH_BRANCH_EVENT` 的 handler 仍在 App.tsx（含上述 checkout + dirty 檢查 + worktree 跳轉），常數仍 export 自 `BottomBar.tsx`。日後要恢復 branch UX，接個觸發點重發 `SWITCH_BRANCH_EVENT` 即可，不必重寫切換邏輯。詳見 `footer-redesign.md`。

**不要改**: 不要用隱藏 tab 跑 git checkout。**不要因為「沒人 emit」就刪掉 App.tsx 的 `SWITCH_BRANCH_EVENT` handler 或 BottomBar 的常數** — 是刻意休眠保留。

---

## 50. Per-project storage 統一在 `<userData>/projects/<id>/`

**決策**: 所有 per-project 的檔案產物都放在 `<userData>/projects/<projectId>/` 底下（PM project note、user-facing notes、note 圖片資料夾、未來新功能…）。Project 移除時 `removeProjectStorage(id)` 一行 `fs.rm` 整包清掉。

**原因**:
- 之前 PM note 自己一個 top-level `pm-notes/<id>.md` 目錄，且 project 移除時根本沒清——orphan 檔案累積
- 新功能（Notes, 之後可能有更多）每個都自選位置 = 每加一個就要記得改 removeProject 邏輯，必然會漏
- 改成統一目錄後，新加 per-project feature 只要寫進 `projectDir(id)`，移除是免費的
- ProjectId 不會跨 instance 共用，加上層 `projects/` 資料夾不會跟 sessionId-keyed 的東西（agent context）混

**配套**:
- `src/main/project-storage.ts` 提供 `projectDir(id)` / `ensureProjectDir(id)` / `removeProjectStorage(id)`
- `src/main/migrations/migrate-pm-notes.ts` 啟動時 idempotent 搬家：copy → verify → unlink，partial run 安全 resume
- `IPC.PROJECT_SAVE` handler 比較 old/new id set，刪掉的 id 觸發 `removeProjectStorage`

**不適用**:
- Agent context（`~/.shelf/agent-context/{sessionId}.json`）跟 IndexedDB agent UI history 是 sessionId-keyed 不是 projectId-keyed，多 session 共用一個 project，硬塞進來反而扭曲關係——維持現狀
- App-global 檔案（settings、pm-history、pm-global-note、ssh-servers、logs）不要動

**不要改**:
- 不要在新 per-project feature 自己 `<userData>/foo-<id>.md`，直接用 `projectDir(id)`
- 不要在 PROJECT_SAVE handler 之外另起 cleanup 路徑——單一進入點才不會漏


## 51. Notes 走 file storage + auto-GC，不用 base64 inline

**決策**: 使用者貼進 Notes panel 的圖片存成獨立檔案（`projects/<id>/images/<uuid>.<ext>`），markdown 引用 `![](images/<uuid>.png)`。每次 `writeNote` 掃 markdown 抓 ref，刪掉沒被 ref 的 image 檔。Renderer 透過 `shelf-image://<projectId>/<filename>` custom protocol 讀圖。

**原因**:
- Base64 inline 看似省事（刪文字 = 圖片自然消失，無生命週期），但 1MB 截圖→1.4MB 文字，5–10 張就讓 textarea / marked render 卡爆
- File + auto-GC 用 ~15 行 regex scan 達到「刪 ref → image 檔自動消失」一樣的體感，且 .md 維持純文字幾 KB
- `shelf-image://` 比 `file://` 更安全：在 main 端做 segment 驗證（拒絕 `..` / `/`），不暴露任意 file system 讀取

**配套**:
- `src/main/notes-store.ts` 的 `writeNote` 內呼叫 `garbageCollectImages` (regex `/images\/([\w.-]+)/g`)
- `src/main/notes-protocol.ts` 用 `protocol.handle()` (Electron 25+ 新 API)，scheme 在 `whenReady` 前 `registerSchemesAsPrivileged({ standard, secure, supportFetchAPI })`
- Renderer paste handler 抓 image MIME → IPC `notes:save-image` → 拿 ref 插入游標處
- Preview 渲染前用 regex rewrite `images/x` → `shelf-image://<id>/x`（marked 的 `![](images/x)` 跟 raw `<img src>` 兩種都處理）

**不要改**:
- 不要為了「不留垃圾」做嚴格 cleanup（每次 paste 都檢查全部 ref）— 太緊會誤刪正在編輯但還沒寫回的引用；目前 GC 只在 `writeNote` 觸發，跟磁碟 state 強同步
- 不要切到 base64「就一兩張小圖沒差」— 一旦 user 貼一張全螢幕截圖就崩，沒回頭路

---

## 56. Local shell HISTFILE=/dev/null：tab 間 history 完全隔離、不持久化

**決定**: `LocalUnixConnector.createShell()` spawn pty 時把 `HISTFILE=/dev/null` 塞進 env。每個 tab 的 shell process 只保留 in-memory history（↑↓ 在當前 session 內仍可叫回剛跑的指令），但不寫檔、不共享、關 tab 就沒。

**為什麼不直接用 user 的 `~/.zsh_history`**:
- Shelf 把 project 當 working context；多個 project 共用同一個 history file 會洩漏「我剛在哪個 project 跑了什麼」的狀態
- 多 tab 並開時，A tab 跑的指令污染 B tab 的 ↑（zsh `share_history` / inc_append 行為）
- 使用者實際 workflow：以 session 內微調指令重跑為主，少用 `history | grep xxx` 翻舊紀錄

**為什麼不寫 per-project history file**:
- 多一個檔案要管（mkdir、project 刪除 cleanup、備份範圍）
- 為了極少使用的 cross-session 翻舊紀錄需求增加架構複雜度，不值得
- 若之後有人需求，HISTFILE 從 `/dev/null` 改成 `userData/shell-history/<projectId>.history` 是一行改動，model 相容

**範圍**:
- Phase 1：只 `local/unix`（macOS / Linux 的 bash / zsh）
- Phase 2 候補：`local/win32` (PowerShell 用 PSReadLine，要 `Set-PSReadLineOption -HistorySavePath`)、`wsl`、`ssh`（遠端 history，要 ssh remote exec 注入，corner case 多）

**不要改**:
- 不要回到 `getShellEnv()` 直接傳（會繼承使用者 `HISTFILE` 設定）
- 不要 default 啟用持久化 — 沒有使用者訴求前先保持簡單


