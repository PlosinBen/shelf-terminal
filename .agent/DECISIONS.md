# DECISIONS — Architecture Decision Records

## 1. Event Bus 驅動 UI 動作

**決策**: 所有 user action（close tab、new tab、connect 等）透過 `events.ts` 的 pub/sub emit，副作用集中在 `App.tsx` 的 event handler 處理。

**原因**: UI 元件（TabBar、Sidebar、useKeybindings）只管觸發，不需要知道 pty kill、terminal dispose、persist 這些實作細節。避免同一個邏輯散落在多個檔案。

**不要改**: 如果把副作用分散回各元件，新增 trigger point 時就要到處複製 cleanup 邏輯。

---

## 2. Connector 抽象層（Factory Pattern）

**決策**: `src/main/connector/index.ts` 的 `createConnector(connection)` 根據 connection type + OS 回傳對應實作。IPC handler 呼叫 factory 取得 connector 再操作。Preload 只是 RPC bridge，不含 dispatch 邏輯。

**原因**: 所有 connection-specific 邏輯（spawn、listDir、upload、cleanup）收在各自的 connector 實作裡，消費端（pty-manager、file-transfer、IPC handler）不需要 switch connection type。新增 connection type 只需加一個 connector 檔案 + 註冊到 factory。

**不要改**: 如果把 connection dispatch 散回各消費端，每個用到 spawn/listDir/upload 的地方都要重複 switch。

---

## 3. xterm Instance Cache

**決策**: `TerminalView` 用全域 Map cache xterm instance，tab 切換時不 destroy/recreate。

**原因**: xterm.js 初始化成本高（DOM 操作、WebGL context），cache 讓 tab 切換瞬間完成且保留 scrollback。

**不要改**: 如果每次切 tab 都 destroy + recreate，會丟失 scroll 位置和歷史內容。

---

## 4. SSH ControlMaster Multiplexing

**決策**: SSH 連線使用 `ControlMaster=auto` + `ControlPersist=600`，同 project 多個 tab 共用 TCP 連線。

**原因**: 避免每開一個 tab 都重新認證和握手。600 秒 persist 讓短暫斷開的 tab 不需要重連。

**不要改**: 不用 ControlMaster 的話每個 tab 獨立 SSH 連線，開 5 個 tab = 5 次認證。

---

## 5. Keybinding 參數化 Action

**決策**: `comboToAction` map 支援 `action_param` 格式（如 `switchTab_3`），handler 用 `split('_')` 解析。

**原因**: `mod+1~9` 切 tab 是同一個行為帶不同參數，不需要定義 9 個獨立 action type。

**不要改**: 如果用特例處理（if/else 判斷數字），會破壞 comboToAction 的統一流程。

---

## 6. Lazy Connect

**決策**: App 啟動時只載入 project 列表，不自動 spawn terminal。用戶點擊或按 Enter 才連線。

**原因**: 用戶不一定需要同時連所有 project。SSH 連線成本高，自動連線會拖慢啟動。

**不要改**: 自動連線在 project 多時會 spawn 大量 pty，浪費資源且拖慢啟動。

---

## 7. userData 隔離純靠 Electron 內建訊號（`isPackaged` + `--user-data-dir`）

**決策**:
- 隔離邏輯集中在 `src/main/user-data-path.ts` 的 `applyUserDataIsolation()`，`index.ts` top-level 呼叫一次。函式自帶 idempotent guard。
- 完全不依賴任何 env var 或 build-time inline，只看兩個 Electron 自帶訊號：
  - `app.isPackaged === true` → 真正打包的 end-user 安裝版 → 保留 OS-default userData 路徑（prod）。
  - `app.commandLine.hasSwitch('user-data-dir')` → 呼叫端（E2E tempdir）自己負責路徑 → 不動它。
  - 其他情況（`npm run dev`、`npx electron .`、`npm run pack` 輸出、手動跑 unpackaged build）→ 一律在 OS-default 路徑後面加 `-dev` 後綴。
- E2E 測試在 `e2e/helpers.ts` 每個 worker 自己 `mkdtempSync` 一個 tempdir，啟動 Electron 時帶 `--user-data-dir=<tempdir>`，結束後 `rm -rf`。
- NODE_ENV 保留它原本的角色（vite mode、E2E 視窗 gate、`test:*` script 的行為），但 **不參與** userData 決策。

**原因**:
- 舊版靠「有沒有帶 `NODE_ENV`」當 gate：本地 `npx electron .` / `npm run pack` 剛好沒帶，就直接寫進正式 userData。v0.5.0 `projects.json` 遺失事件就是這個風險的具體化。
- 曾經考慮過 `SHELF_RELEASE` / `SHELF_USERDATA_SUFFIX` 這類專屬 env var + vite `define` inline，但有兩個問題：(1) 每個開發者跑不同 script 都要手動帶對變數才不會誤寫 prod；(2) packaged `.app` 雙擊啟動沒有 runtime env，必須靠 build-time inline，多一層維護負擔。
- `app.isPackaged` 是 Electron 原生訊號，packaged runtime 可以直接讀，不需要 inline 任何東西。Safe-by-default：任何 unpackaged 啟動（dev、ad-hoc `npx electron .`、本地 `pack` 輸出）都自動掛 `-dev`。
- `--user-data-dir` 是 Chromium/Electron 官方開關，傳下去 Electron 自己會優先採用；我們只是判斷有沒有帶，帶了就不多事。E2E 用 tempdir 走這條路既不汙染 dev 資料、每次測試也都是 fresh state。
- 集中到一個 module + idempotent guard：未來如果有人在別的 main-process 檔 top-level 再加一次 setPath，guard 會把它擋掉。

**不要改**:
- 把 userData gate 換回 `NODE_ENV`（或任何 vite 會自動覆寫成 `production` 的變數）→ 本地 pack 跟 CI release 再次無法區分，回到 v0.5.0 的 bug。
- 把 fallback 拿掉變成「isPackaged 以外都寫 OS-default」→ safe-by-default 失效。
- 把 `applyUserDataIsolation()` 從 top-level 搬進 `whenReady` → 晚於 Electron 內部初始化（Cookies、Cache），部分資料會寫錯路徑。
- E2E 改回 `NODE_ENV=test` 推算路徑：之前的作法會刪到跟 dev 共用的 userData，且 worker 之間無法併行。必須走 tempdir。

---

## 8. Settings Shallow Merge with Defaults + Deep Merge Keybindings

**決策**: `loadSettings()` 用 `{ ...DEFAULT_SETTINGS, ...saved }` merge，新增 setting key 時舊的 settings.json 自動補預設值。`keybindings` 額外做 deep merge（`{ ...DEFAULT_KEYBINDINGS, ...saved.keybindings }`），確保新增的快捷鍵不會被舊設定覆蓋掉。

**原因**: 向前相容。用戶升級版本後不需要手動加新欄位。keybindings 是巢狀物件，shallow merge 會讓舊存檔整個覆蓋 defaults，導致新快捷鍵消失。

**不要改**: 如果直接讀 saved 不 merge，舊版 settings.json 缺少新欄位會 crash。如果 keybindings 不 deep merge，每次新增快捷鍵都要手動刪 settings.json 才能生效。

---

## 9. electron-builder 直接 Publish

**決策**: CI 的 `npm run dist:mac/win/linux` 讓 electron-builder 直接 publish 到 GitHub Release（不拆 build + upload 兩步）。

**原因**: 參考 refer repo 的 working pattern。拆成兩步會遇到 GH_TOKEN 權限問題。

**不要改**: 分開 build 和 publish 需要額外處理 artifact 上傳和 release creation 的權限。

---

## 10. Split Pane 用 CSS Flex 不用 Absolute

**決策**: Split view 用 `.split-view` flex 容器 + `.split-pane` 各佔 50%，非 split 時 terminal-container 用 `position: absolute; inset: 0`。

**原因**: flex 讓兩個 pane 自動分配寬度，ResizeObserver 自動觸發 xterm fit。不需要手動計算尺寸。

**不要改**: 用 absolute 定位需要手動計算寬度和 resize，增加複雜度。

---

## 11. Terminal 持久渲染（不 unmount）

**決策**: 所有 project 的所有 tab 都持久渲染，用 `display: none` 隱藏非 active 的。切換 project/tab 只改 visibility。

**原因**: 如果只渲染 activeProject 的 tabs，切換 project 時 React unmount → remount → 重新 spawn pty，丟失 terminal 狀態。

**不要改**: unmount/remount 會導致 pty 重複 spawn 和 terminal 內容遺失。

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

## 15. Updater state machine 抽成純 reducer

**決策**: 自動更新的狀態轉移放在 `updater-state.ts` 的 `reduceUpdaterStatus(state, event)` 純函式裡。`updater.ts` 只負責接 electron-updater event 與 IPC，呼叫 reducer 後 broadcast。

**原因**:
- electron-updater 的 singleton 在單元測試裡沒辦法 mock 乾淨；把 transition 邏輯抽出來後 reducer 可以用 vitest 直接測（21 個 case 涵蓋每個事件 × 每個狀態的 guard）。
- 用 reducer 才能集中表達「下載中收到 not-available 不能 clobber」「error 從 downloading 退回 available 讓使用者重試」這類細節。

**不要改**: 把 transition 寫回 `updater.ts` 的 event handler 裡會讓行為再次無法測試，並讓 guard 散落各處。

---

## 16. Bootstrap 在開窗前先載入 config，失敗時 blocking dialog

**決策**: `app.whenReady()` 裡先呼叫 `bootstrap()` 同步載入 `projects.json` 和 `settings.json`，再 `createWindow()`。`loadProjects` / `loadSettings` 回傳 `LoadResult` discriminated union（`ok | parse | permission | read`），bootstrap 根據錯誤型別跳對應的 `dialog.showMessageBoxSync`：parse 給「Quit / Backup & Continue」、permission/read 只給 Quit。

**原因**:
- 過去 config 損毀時 silent 退回 default，使用者不會意識到自己的 project 列表「不見了」直到下次儲存覆寫。
- Sync dialog 在 ready 階段是少數能 block 的時機；window 都還沒開，視覺上不會看到半成品的 UI 又跳錯。
- E2E 測試用 `SHELF_BOOTSTRAP_DIALOG_RESPONSE=quit|continue` env 變數 mock dialog 回應，避免測試卡在 native 對話框。

**不要改**: 把 dialog 推到 createWindow 之後 / 用 async dialog 會讓 race condition 變多（renderer 已經跟 main 要 cachedProjects 但 cache 還沒填）。

---

## 17. Vitest config 獨立檔，不繼承 vite.config.ts

**決策**: `vitest.config.ts` 是另一份獨立 config，不 extend `vite.config.ts`。

**原因**: `vite.config.ts` 載入 `vite-plugin-electron`，跑單元測試時會嘗試 spawn Electron，整個 vitest 就卡死。獨立 config 跑純 TypeScript 模組就好。

**不要改**: 兩份 config 共用會把 electron plugin 拉進 test 環境。

---

## 18. App 快捷鍵在 Capture Phase 攔截 + stopPropagation

**決策**: `useKeybindings` 在 window capture phase 監聽 keydown。匹配到已註冊的快捷鍵後執行 action 並 `preventDefault` + `stopPropagation`，事件不會到達 xterm。

**原因**: xterm 會攔截大部分鍵盤事件（包括 Ctrl+D、Ctrl+T 等）。用 capture phase + stopPropagation 確保 app 快捷鍵優先於 xterm。新增快捷鍵只需在 types + defaults + useKeybindings 註冊，不需要改 TerminalView。

**不要改**: 如果讓 xterm 先收到事件再判斷要不要放行，每新增一個快捷鍵都要同步改 TerminalView 的 `attachCustomKeyEventHandler`。

**例外**: Windows/Linux 的 Ctrl+V（paste）和 Ctrl+C（copy when selected）不是 app 快捷鍵，是瀏覽器原生行為。這兩個在 TerminalView 的 `attachCustomKeyEventHandler` 裡 return false 讓瀏覽器處理。

---

## 19. 上傳清理：session-based、cutoff 從檔名解出來

**決策**: `<cwd>/.tmp/shelf/` 的清理走兩條路：
- **自動**：每個 project 在 Shelf process 內第一次 spawn pty 時，`maybeScheduleCleanup()` 排一個 3 秒後的 fire-and-forget cleanup。同一個 project 在這個 Shelf process 內只跑一次（用 `cleanedProjects: Set<string>` 去重）。Cutoff 是 `SESSION_STARTED_AT`（process 啟動時的 ms）— 比這個舊的就是上一個 session 留下來的，可以刪。
- **手動**：ProjectEditPanel 的 Clear 按鈕呼叫 `clearUploads()`，無論時間戳直接清空 `.tmp/shelf/`（保留目錄本身）。

**檔案是否「過期」是從檔名解出來的**：upload 時的 prefix 是 `Date.now().toString(36) + counter`，`parseUploadPrefix()` 從檔名拆出來反解回 ms，不依賴 mtime。

**原因**:
- **不用 mtime + `find -mmin`**：`find -mmin` 的解析度是「捨入到下一分鐘」，cutoff 跟剛上傳的檔差幾秒就會誤刪當下這次 session 的檔。Filename-encoded ts 是精確的 ms。
- **portable**：四種 transport 只需要 `ls` 跟 `rm`，不需要 `find` 或 `stat`。
- **只動我們自己的檔**：`parseUploadPrefix` 對非 Shelf prefix 回 `null`，使用者自己丟到 `.tmp/shelf/` 的檔不會被掃。
- **fire-and-forget + 3 秒延遲**：讓 first paint 跟 shell startup 不被 cleanup 的 ssh exec 卡到。錯誤只 log 不 throw — cleanup 永遠不能擋 pty spawn。
- **per-process dedupe**：同一個 Shelf process 內 cleanup 一次就夠了；本 session 之後的上傳是 fresh 的，不該被自己的 cleanup 動到。

**不要改**:
- 換回 mtime cutoff 會踩 `find -mmin` 的捨入問題，可能在使用者剛 paste 完就把同次的檔刪掉。
- 如果讓 cleanup `await` 在 spawn 之前，遠端 `ssh exec` 的延遲會直接打到 first tab 的開啟時間。
- 把 dedupe 拿掉會讓每次 spawn 都重跑 cleanup，浪費 SSH/docker exec。

---

## 19. Worktree 是獨立 Project

**決策**: Git worktree 以獨立 project 存在於 sidebar，透過 `parentProjectId` 關聯 parent project。繼承 parent 的 connection 設定。Worktree path 放在 parent cwd 的同層目錄（`<parentDir>/<projectName>-<branchName>`）。

**原因**:
- 把 worktree 當 sub-project 保持 sidebar 扁平架構，不需要巢狀 tree view 和複雜的拖曳邏輯。
- Worktree 鎖定一個 branch，行為上就是一個獨立的工作目錄，跟 project 概念一致。
- 放同層目錄（非 repo 內部）避免需要 `.gitignore` 排除。

**不要改**: 如果把 worktree 做成 project 的子層級，sidebar 要從 flat list 變 tree，拖曳排序邏輯會複雜很多。

---

## 20. Connector exec() 方法

**決策**: `Connector` 介面加 `exec(cwd, cmd)` 方法，用於在目標環境執行非互動式指令（如 git 操作）。各 connector 實作對應的 execFile 呼叫。Git IPC handler 透過 connector.exec() 執行，不直接暴露 exec 到 renderer。

**原因**: git worktree 操作需要在遠端（SSH/Docker）執行指令，透過 connector 抽象層可以統一處理，不需要針對每種 connection type 寫不同的 git 邏輯。只暴露特定 git IPC channel 而非通用 exec，避免安全風險。

**不要改**: 不要在 preload 暴露通用 exec API。

## 21. Bottom Bar 顯示 connection / path / branch

**決策**: Terminal section 底部加 BottomBar 元件，左側顯示 connection type 和 cwd，右側顯示 git branch。Branch 可點擊展開 dropdown 切換。Worktree-occupied branches 標示 "worktree"，點擊後跳轉到對應 project（或自動建立）而非嘗試 checkout。

**原因**: 使用者需要快速了解當前 project 的 connection 和 branch 狀態。Branch 切換用 `connector.exec()` 執行 `git checkout`，切換前用 `git status --porcelain` 檢查 dirty 狀態。Worktree branch 不能 checkout（git 限制），改為導航到對應 project 更實用。

**不要改**: 不要用隱藏 tab 跑 git checkout（shell exit code 不可靠）。不要把 worktree branch 設為 disabled（使用者會困惑為什麼不能點）。

## 22. Unicode11Addon 預設不啟用

**決策**: xterm.js Unicode11Addon 仍然載入（註冊可用版本），但預設不啟用 `activeVersion`。使用者可在 Settings 勾選 "Unicode 11" 開啟。

**原因**: Unicode11Addon 對 Ambiguous width 字元（如 oh-my-zsh prompt 中的 `→` `✗`）的寬度計算與 zsh 不一致，導致 tab completion 時字元重複顯示。這是 xterm.js 已知限制（#1453）。預設關閉避免大多數使用者踩到此問題。

**不要改**: 不要完全移除 Unicode11Addon（部分使用者需要 CJK/emoji 支援）。

## 23. Engine History 走 File-based JSON（非 SQLite）

**決策**: Copilot / Gemini engine 的對話持久化用一份 JSON 檔 per session，放在 `<userData>/agent-state/<sessionId>.json`，透過注入到 engine 的 `HistoryStore` adapter（`createFileHistoryStore()`）讀寫。Schema 帶 `version: 1`、save 用 tmp + rename atomic write、path-traversal guard 只接受 `[A-Za-z0-9_-]{1,128}` 的 id。

**原因**:
- Engine 原本就是 stateless — 每次 request 把整段 history 送過去。用場就是「整包 load / 整包 save」，query/partial update 不是需求，上 SQLite 純粹 over-engineer。
- 業界參考（OpenAI Agents SDK Python、Continue.dev、Aider、cli-continues）主流也是 local JSON file，一個 session 一個檔，好 debug 也好手動備份。
- Claude side 走 SDK 自帶 transcript，兩邊對稱性透過 `providerSessionIds[provider]` 同一張表達成，engine 只暴露跟 Claude 對齊的 `resume` 介面。

**不要改**:
- 不要讓 engine 直接 `import fs` — 一定透過 `HistoryStore` adapter，否則 testability 和未來換後端（SQLite / IndexedDB）會困難。
- 不要把 system prompt 存進檔案：system prompt 每次從 cwd/mode/project instructions 重建，落盤只會 hydrate 出 stale 版本。

## 24. `/compact` 的便宜 model 選擇放在 provider

**決策**: `/compact` 要用什麼 model 做摘要，由 provider 透過 `EngineConfig.pickCompactModel?: (current) => string | undefined` callback 決定。Gemini 回 `gemini-2.5-flash`（已在 flash 則回 undefined）；Copilot 先檢查 `contextWindows.has('gpt-4o-mini')`（代表在使用者的 quota 裡）才推薦，否則回 undefined。Engine 的 `/compact` 只做 `config.pickCompactModel?.(currentModel) ?? currentModel`。

**原因**:
- Engine 是 provider-agnostic 的 OpenAI-compat 核心，它不該知道「哪個 provider 對應哪個便宜 model」這種業務知識。原本文件裡提案的 `COMPACT_MODEL: Record<provider, id>` 等於把 provider 清單硬塞回 engine，新增一個 provider 要改兩處。
- Provider 已經擁有判斷 model 可用性的狀態（gemini 靜態 list、copilot 動態 `contextWindows`），callback 讓 provider 直接基於自己的狀態判斷，回 `undefined` 就等同「沿用 current」，engine 不會幫它猜。

**不要改**: 不要把 provider name 或 model list 回傳 engine 讓 engine 選 — 這會反轉依賴方向。

## 25. Engine History 清理：只在 Project Remove 時掃

**決策**: 持久化檔案的清理有兩個觸發點 —
1. `/clear` 或 engine 的 `clearHistory()` → 刪該 session 的單一檔（engine 內 `clearAllState()` fire-and-forget）
2. Project 被刪除 → renderer 收集 `proj.config.agentSessionIds` 所有 id，呼叫新 IPC `agent.deleteHistories()`，main 端 `deleteHistoryFiles()` 一次性批次刪

**不做 app 啟動時 sweep 孤兒檔。**

**原因**:
- 正常流程兩個觸發點就能覆蓋：`/clear` 處理用戶重開對話、project remove 處理永久清理。孤兒檔只會出現在異常崩潰 + 之後改 config 造成的情況，成本低。
- App 啟動是 hot path，讀 `projects.json` + 掃 `agent-state/` 做 diff 會多一次 fs 掃描和潛在錯誤處理，CP 值差。

**不要改**: 如果未來真的觀察到孤兒檔累積，再加「手動在 Settings 清理」按鈕比較划算，不要在啟動時 sweep。

## 26. Auto-compact at 80% + structured summary prompt

**決策**: Engine 在每次 query 結束後（turn loop 跑完、persist 之前）檢查 `(prompt_tokens + completion_tokens) / contextWindow`，超過 80% 自動觸發 `performCompact()`。Compact prompt 使用 structured sections（Goal / Completed / Relevant files / Open questions / Current task）而非 free-form。`performCompact()` 是 `/compact` 和 auto-compact 的共用函式。

**原因**:
- 使用者不一定知道 context 快滿了，沒有 auto-compact 會直接撞到 API 400 錯誤。
- 用 `prompt + completion` 而非只用 `prompt`，因為 completion tokens 下一輪會變成 prompt 的一部分，估算更保守。
- Structured sections 比 free-form 更穩定，便宜 model（mini / flash）也能產出一致的摘要格式。
- 80% 門檻參考 Copilot CLI 的做法，留 20% buffer 給 tool 結果。

**不要改**:
- 門檻不要拉到 95%——tool call 回來的結果可能很大，留太少 buffer 會來不及 compact。
- Auto-compact 必須是 best-effort（try/catch），永遠不能阻擋使用者的回覆。
- 不要在 ephemeral `/ask` turn 觸發——一次性查詢不該改動 history。
