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

## 7. NODE_ENV 隔離 userData

**決策**: `app.setPath('userData', path + '-' + NODE_ENV)`，dev/test/production 各自獨立資料目錄。

**原因**: 避免 E2E 測試清掉 production 的 projects.json，或 dev 的設定污染 production。

**不要改**: 共用路徑會導致跑測試時意外刪除生產資料。

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
