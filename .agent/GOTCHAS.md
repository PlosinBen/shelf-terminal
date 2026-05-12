# GOTCHAS — Non-obvious Behaviors & Past Issues

## 1. DEFAULT_SETTINGS 不能放在 types.ts

**現象**: Renderer 啟動時報 `settings is not defined`，白屏。

**原因**: `types.ts` 通常只有 type export，vite 在 production build 時可能對 runtime value export 處理不一致。`DEFAULT_SETTINGS` 放在 `types.ts` 裡，store.ts import 它時在 bundle 中變成 undefined。

**解法**: Runtime value 獨立放在 `shared/defaults.ts`，type 留在 `types.ts`。

---

## 2. App.tsx 解構 useStore() 必須包含所有使用的欄位

**現象**: `settings is not defined` ReferenceError，app 白屏。

**原因**: `const { projects, activeProjectIndex, sidebarVisible } = useStore()` 漏了 `settings`，但後面直接用 `settings.themeName`。在 minified bundle 中變成未宣告的變數。

**解法**: 確保 `useStore()` 解構包含所有後續使用的欄位。

---

## 3. node-pty 需要 electron-rebuild

**現象**: `pty.spawn` 報 `posix_spawnp failed` 或 native module 版本不符。

**原因**: node-pty 是 native module，npm install 時編譯的是 Node.js 版本，不是 Electron 的 Node。

**解法**: `postinstall: electron-rebuild`，CI 上需要 Python + setuptools for node-gyp。

---

## 4. WSL 雙重 Prompt

**現象**: WSL 連線後 terminal 顯示兩次 `user@host:~$`。

**原因**: `wsl.exe --cd /path` 啟動時 shell profile 載入一次印 prompt，然後 login shell 又印一次。

**解法**: 改用 `wsl.exe -d distro -- bash -l -c "cd /path && exec $SHELL -l"`，只有一個 login shell。

---

## 5. 檔案上傳 mkdir + cat 串在同一個 sh -c

**現象**: 在 `file-transfer.ts` 把 `mkdir -p` 和 `cat >` 拆成兩次 ssh / docker exec 呼叫時，有時候 race 到 cat 看不到目錄。

**解法**: 一律用 `sh -c "mkdir -p '<dir>' && cat > '<path>'"`，目錄建立和寫入在同一個遠端 shell 內順序執行。`mkdir -p` 本身就 idempotent，目錄已存在不會錯。

**注意**: 路徑用 `shellSingleQuote` 包起來，遠端 shell 不會二次解析任何字元；若改回呼叫 `execFile` 走 scp/docker cp，就要重新處理跨 shell 的 quoting。

---

## 6. Paste 使用 Capture Phase 攔截，Drop 使用 Bubble Phase

**現象**: 檔案 paste 沒反應。

**原因**: xterm 的 `xterm-helper-textarea` 攔截 paste event 後不會冒泡到 container。必須用 capture phase（`addEventListener` 第三參數 `true`）在 xterm 之前攔截。Drop 不需要 capture phase 因為 xterm 不攔截 drop 事件。

**判斷邏輯**:
- Paste：clipboard 含有 `kind === 'file'` 的 item 就走上傳；若同時帶 `text/html`（從瀏覽器複製富文本，image 只是 favicon）則放行讓 xterm 當文字貼上。
- Drop：`dataTransfer.files` 非空就走上傳，不檢查 MIME（任何檔案都收）。

---

## 7. Idle Notification 需要使用者輸入 + 5 秒門檻

**現象**: 快速指令（如 `ls`）或 agent CLI（Claude Code、Copilot）的背景輸出不會觸發通知。

**原因**: 兩個條件都要滿足：(1) `userInput = true` — 只有使用者透過鍵盤輸入（`writePty`）才標記，agent 自行產生的 pty output 不算。(2) `MIN_ACTIVE_MS = 5000` — output 必須持續 5 秒以上。

**注意**: 這是 intentional — 避免 agent CLI 背景輸出不斷觸發通知。

---

## 8. electron-builder CI 需要 top-level permissions

**現象**: GitHub Actions build 報 `403 Forbidden`。

**原因**: electron-builder 在 build 時自動嘗試 publish 到 GitHub Release，需要 `contents: write` 權限。如果權限只在 release job 而非 build job，會被拒絕。

**解法**: workflow 頂層設 `permissions: contents: write`，讓 electron-builder 直接 publish。

---

## 9. Linux deb 打包需要 author email

**現象**: CI Linux build 報 `Please specify author 'email'`。

**原因**: electron-builder 打 `.deb` 時需要 maintainer email，從 `package.json` 的 `author` 欄位讀取。

**解法**: `package.json` 的 `author` 必須包含 email：`"PlosinBen <plosinben@gmail.com>"`。

---

## 10. vite build cache 可能不反映檔案搬移

**現象**: 把 `DEFAULT_SETTINGS` 從 `types.ts` 搬到 `defaults.ts` 後，build 產出的 hash 沒變，問題依舊。

**原因**: vite 的 build cache 認為內容沒變（只是 import source 不同）。

**解法**: `rm -rf dist` 強制清除再 build。

---

## 11. Playwright E2E 共用 worker scope

**現象**: 測試之間的 state 互相影響（例如一個測試建了 project，後面的測試看到多個 project）。

**原因**: `shelfApp` fixture 是 `scope: 'worker'`，同一個 worker 的所有 spec file 共用同一個 Electron instance。

**注意**: 斷言不要用精確的 count（如 `toHaveCount(1)`），改用 `toBeGreaterThanOrEqual(1)` 或 `.first()`。

---

## 12. autoHideMenuBar 只影響 Windows

**現象**: macOS 上設 `autoHideMenuBar: true` 沒效果。

**原因**: macOS 的 menu bar 在螢幕頂部（系統層級），不在視窗內。`autoHideMenuBar` 只影響 Windows/Linux 的視窗內 menu bar。

**注意**: 這是正常行為，不是 bug。

---

## 13. Connector 問題可用 Local 重現

**現象**: WSL 雙重 prompt 問題，看似只能在 Windows 測試。

**原因**: 所有 connector 都透過 `createConnector()` factory 走統一的 `Connector` 介面（`createShell`、`listDir`、`uploadFile` 等），spawn 邏輯集中在 `pty-manager.ts` 的 `connector.createShell(cwd)`。問題通常不是特定 connection type 造成的。

**注意**: Connector 統一介面後，spawn/connect/disconnect 等行為在 local 上就能驗證。不需要等特定平台測試。修 bug 前先在 local 用 log 確認。

---

## 14. TerminalView 的 paste/drop handler 是 closure，settings 要走 ref

**現象**: 改了 Settings 的 Max Upload Size 後，已經開著的 tab 還是用舊的上限。

**原因**: paste/drop listener 在 `useEffect([tabId])` 裡綁一次就不再重綁，閉包抓的是 mount 當下的 `settings.maxUploadSizeMB`。

**解法**: `TerminalView` 用 `maxUploadMBRef = useRef(settings.maxUploadSizeMB)` 並在每次 render 同步 `.current`，handler 內讀 `.current` 而非閉包變數。`connection` 與 `cwd` 不會在 tab 生命週期內變動，仍然走閉包即可。

---

## 15. npm sudo 會污染 ~/.npm 導致後續 install EACCES

**現象**: `npm install vitest` 報 `EACCES: permission denied` 寫 `~/.npm/_cacache`，但專案本身的 node_modules 是使用者擁有的。

**原因**: 過去用過 `sudo npm install -g <pkg>` → npm 在 `~/.npm/_cacache` / `~/.npm/_logs` 留下 root-owned 檔，之後非 sudo 的 npm 寫不進去。

**解法**:
1. 確認 global prefix 是使用者可寫的路徑（`npm root -g` 不應指向 `/usr/local/lib/node_modules` 等系統目錄）。具體怎麼設定是使用者自己的環境問題（版本管理工具、手動設 prefix、或其他）。
2. 把曾經 sudo 裝過的 global package 重新非 sudo 安裝：先 `sudo npm uninstall -g <pkg...>`、再 `sudo rm -rf ~/.npm/_cacache`、最後 `npm install -g <pkg...>`。
3. AI CLI tool 的 session（Claude Code、Copilot、Gemini 等）放在 `~/.copilot/` / `~/.claude/` / `~/.gemini/` 等獨立目錄，npm uninstall 不會碰。

**規則**: 即使是全域 CLI 工具也用 `npm install -g`，**永遠不要 `sudo npm`**。

---

## 16. parseUploadPrefix 必須卡長度 + 時間範圍，不然會誤刪使用者檔

**現象**: Session cleanup 把使用者自己丟進 `.tmp/shelf/` 的檔（例如 `manually-placed.log`）也刪掉了。

**原因**: 早期版本的 `parseUploadPrefix()` 只檢查「是不是 `[a-z0-9]+-...`」就接受。`manuall`（取 prefix 去掉最後一個 counter char）剛好是合法 base36，`parseInt('manuall', 36)` ≈ 48 億 ms，遠小於現在的 `Date.now()`，於是被歸類為 stale 然後刪掉。

**解法**: 在 `file-transfer.ts` 的 parser 裡同時要求：
1. `prefix.length >= 9` — 真實的 Shelf prefix 是 8 字元 base36 timestamp + 1 counter char，1972~2059 都是 9 字元。
2. 解出來的 ms 落在 `[2020-01-01, 2100-01-01)` 這個 sanity window。

**注意**: 第二個 floor 同時擋掉「9 字元但解出來變 1995」的字（例如 `aaaaaaaaa`）。如果以後要改 prefix 格式，這兩個 guard 都要同步調整，並補上 regression test（`file-transfer.test.ts` 已經有 `manually-placed.log` 跟 `aaaaaaaaa` 兩個 case）。

---

## 17. macOS 自動更新需要 code signing

**現象**: macOS 上 electron-updater 檢查到新版但無法安裝更新。

**原因**: `.github/workflows/build.yml` 設了 `CSC_IDENTITY_AUTO_DISCOVERY: false`，CI build 出來的 macOS binary 沒有簽名。electron-updater 在 macOS 上使用 Squirrel.Mac，要求更新包必須經過 code signing 才能安裝。

**解法**: 需要 Apple Developer ID certificate（Apple Developer Program, $99/年），然後：
1. 匯出 `.p12` 憑證，base64 encode 存到 GitHub Secrets（`CSC_LINK` + `CSC_KEY_PASSWORD`）
2. 移除或改掉 `CSC_IDENTITY_AUTO_DISCOVERY: false`
3. 可能還需要 notarization（macOS 10.15+ 要求）

**注意**: Windows 不需要 code signing 就能自動更新。在沒有 Apple 憑證之前，macOS 用戶只能手動下載新版。

---

## 18. App 快捷鍵 Capture Phase + stopPropagation

**現象**: 快捷鍵（如 ⌘D、Ctrl+D）在 terminal 有 focus 時沒反應，或同時觸發 terminal 行為。

**原因**: xterm.js 在自己的 keydown handler 裡處理鍵盤事件，比 bubble phase 更早。

**解法**: `useKeybindings` 在 window capture phase 攔截，匹配到 app 快捷鍵後 `stopPropagation`，xterm 完全收不到。新增快捷鍵只需在 types + defaults + useKeybindings 註冊。見 Decision #18。

---

## 19. Windows Ctrl+V/C 需要 Custom Key Event Handler

**現象**: Windows/Linux 上 Ctrl+V 貼上、Ctrl+C 複製無效。

**原因**: xterm.js 預設把 Ctrl+V 當作 `\x16`、Ctrl+C 當作 `\x03` 送進 pty。這兩個不是 app 快捷鍵（不在 useKeybindings 裡），所以 capture phase 不會攔截它們。macOS 用 Cmd+V/C 不受影響。

**解法**: 在 TerminalView 用 `term.attachCustomKeyEventHandler()` 對非 Mac 平台攔截 Ctrl+V 和 Ctrl+C（有選取時），return `false` 讓瀏覽器處理。

---

## 20. Tab Mute 狀態不持久化

**現象**: 重啟 app 後 tab 的 mute 狀態消失。

**原因**: mute 狀態只存在 main process 的 `mutedTabs` Set 中，沒有寫入 settings 或 projects.json。

**注意**: 這是 v0.2.4 的設計——僅 runtime mute，重啟重置。如果未來要持久化需另外實作。

---

## 21. xterm.js 6.0 pre-minified bundle 不能被 esbuild 二次 minify

**現象**: Production build 的 terminal 執行 vim、claude 等 TUI app 時卡住無回應。DevTools 顯示 `ReferenceError: i is not defined` at `requestMode`。

**原因**: `@xterm/xterm@6.0.0` 出廠就是 minified 的 ESM bundle。Vite 預設用 esbuild 再次 minify 時，破壞了 `requestMode()`（DECRPM handler）裡 closure 捕獲的變數 `i`。這個 crash 發生在 write buffer 的 `_innerWrite` 裡，導致後續所有 pty 資料處理中斷。見 [xtermjs/xterm.js#5800](https://github.com/xtermjs/xterm.js/issues/5800)。

**解法**: `vite.config.ts` 設 `build.minify: 'terser'`。terser 不會破壞已 minified 的 closure。

**注意**: `npm run dev` 不 minify 所以不會觸發此問題，只有 production build 會。如果升級 xterm.js 到修復此問題的版本，可以改回 esbuild。

---

## 22. xterm.js open() 只能呼叫一次，remount 要移動 DOM

**現象**: 拖曳排序 project 後 terminal 變黑屏。

**原因**: React 在 `projects.map()` 順序改變時會 unmount/remount TerminalView。remount 時 `initializedRef` 重置為 false，導致 `term.open(newContainer)` 被第二次呼叫。xterm.js 不支援 `open()` 重複呼叫，terminal 進入壞狀態。

**解法**: 在 `terminalCache` 加 `opened: boolean` flag。首次 mount 正常呼叫 `term.open(container)`；remount 時改用 `container.appendChild(term.element)` 把已有的 DOM 搬過去，不呼叫 `open()`。搬移後重新載入 WebglAddon（canvas 移動可能觸發 context loss）。

**注意**: WebGL context loss 的 handler 也要自動 reload addon（`dispose()` + `setTimeout(() => loadWebgl(term), 100)`），否則會 fallback 到 DOM renderer 導致畫面異常。

---

## 23. Unicode11Addon 導致 tab completion 字元重複

**現象**: 在 terminal 輸入任意字元後按 Tab 觸發 shell autocomplete 列表時，已輸入的字元會重複顯示（如輸入 `ca` 顯示 `caca`）。實際送進 shell 的指令是正確的，只是顯示問題。

**原因**: xterm.js Unicode11Addon 把 Ambiguous width 字元（如 prompt 中的 `→` U+2192）當 width 1，但 zsh 可能當 width 2。Tab completion 時 shell 根據自己的寬度計算重繪命令行，游標位置與 xterm 不同步，導致字元偏移重複。這是 xterm.js 的已知限制（[#1453](https://github.com/xtermjs/xterm.js/issues/1453)、[#4753](https://github.com/xtermjs/xterm.js/issues/4753)）。

**解法**: Unicode11Addon 仍然載入（註冊可用版本），但預設不啟用（`unicode.activeVersion` 保持預設 `'6'`）。使用者可在 Settings 開啟「Unicode 11」選項，啟用後即時生效。

**注意**: 啟用 Unicode 11 可改善較新 emoji 和部分 CJK 字元的寬度判定，但只要 prompt 含有 Ambiguous width 字元就可能觸發此問題。

---

## 24. PM Provider 設定存在 settings.json（明文 API key）

**現象**: API key 直接存在 userData 的 settings.json 裡。

**原因**: PM provider config（baseUrl、apiKey、model）跟著 `AppSettings.pmProvider` 走，存在 `settings.json`。Telegram bot token 也在 `AppSettings.telegram`。

**注意**: 目前是明文。Gemini 免費 key 風險低，但如果未來放付費 key，應該考慮移到 `~/.config/shelf/` 或用 OS keychain。

---

## 25. E2E 測試需要先 build（npm run build）

**現象**: E2E 測試找不到 PM 相關的 DOM 元素。

**原因**: E2E 透過 Playwright 啟動 Electron，載入的是 `dist/` 的 static build，不是 vite dev server。如果 `dist/` 裡是舊 build，看不到新加的 UI。

**解法**: 跑 E2E 前一律先 `NODE_ENV=test npm run build`。`npm run test:e2e` script 已經包含 build 步驟。

---

## 26. PM history 持久化在 userData，/clear 會刪檔

**現象**: PM 對話重啟後仍在。

**原因**: `history-store.ts` 每次 user message / assistant response 後寫入 `<userData>/pm-history.json`。啟動時載入。`/clear`（PmView Clear 按鈕）會刪除檔案。

**注意**: 如果檔案損壞（invalid JSON），會靜默從空白開始，不會 crash。

---

## 27. Gemini 免費 tier 容易撞 503

**現象**: PM 對話回 `LLM API error 503: high demand`。

**原因**: Gemini 免費 tier 有 RPM/TPD 限制，尖峰時段容易被 rate limit。

**解法**: 已有 auto-retry（見 #29）。也可以換 model（gemini-2.0-flash 可能較寬鬆）。

---

## 28. Gemini OpenAI-compatible endpoint model 名稱

**現象**: 填 `gemini-2.5-flash-preview-05-20` 回 404。

**原因**: OpenAI-compatible endpoint 的 model ID 跟 native API 不同。正確的是 `gemini-2.5-flash`（不帶日期後綴）。

**解法**: 用簡短名稱：`gemini-2.5-flash`、`gemini-2.5-pro`、`gemini-2.0-flash`。

---

## 29. 503/429 auto-retry 用 exponential backoff

**現象**: PM 對話撞 503 後自動重試。

**原因**: `agent-loop.ts` 對 retryable HTTP error（503/429/500/502/504）自動重試最多 3 次，間隔 5s → 10s → 20s（exponential backoff）。重試期間 UI 顯示 "Retrying in Ns..."。

**注意**: 重試期間按 Stop 可中止。全部失敗後 error 存進 history（role: 'error'），重啟後可見。

---

## 30. PM panel 和 DevTools 收合 tab 由 App.tsx 統一管理

**現象**: 修改 PM 或 DevTools 的收合行為時，改 PmView/DevToolsPanel 沒效果。

**原因**: 收合 tab 的渲染已從各自 component 移到 App.tsx 的 `.right-tabs-collapsed` 容器。DevToolsPanel 的 `if (!devToolsVisible) return null`（不再 return collapsed button）。

**注意**: 新增右側 panel 時要在 App.tsx 加收合 tab，不要在 panel component 裡加。

---

## 31. Settings tab 切換不觸發 re-mount，state 共享

**現象**: 在 Terminal tab 改了值，切到 PM Agent tab 再切回，值還在。

**原因**: SettingsPanel 用一個 `draft` state 管所有 tab 的欄位，切 tab 只是 conditional render 不同區塊。Cancel 會 reset 整個 draft。

**注意**: 這是正確行為。不要把 draft 拆成 per-tab state。

---

## 32. 外部連結必須 `target="_blank"`，否則 Electron window 會被帶走

**現象**: 在 renderer 放 `<a href="https://...">` 沒加 `target="_blank"`，點下去整個 app window 跳到那個網址，terminal state 全失。

**原因**: Electron 預設沒有區分內部/外部連結。`createWindow()` 裡用 `setWindowOpenHandler` 攔 `target="_blank"`/`window.open()` 呼叫 `shell.openExternal` 丟給系統瀏覽器；但 in-window navigation（plain link click）不會經過 handler。

**規則**:
- renderer 所有 `<a href="http(s)://...">` 一律加 `target="_blank" rel="noopener noreferrer"`。
- 不要在 renderer 用 `window.location = url` 跳外部網址。
- 需要程式化開外部連結時，走 IPC → main process → `shell.openExternal`（目前還沒有這個 channel，需要時再加）。

**不要改**: 不要拿掉 `setWindowOpenHandler` 的 scheme 白名單（只放 http/https/mailto），避免 `javascript:` / `file:` 被誤丟 `shell.openExternal`。

---

## 33. PmView retry banner 要靠「任何非 error chunk 都清掉」才會消失

**現象**: LLM 回 429 / 503 → 自動重試 → 重試成功，assistant 正常輸出，但使用者畫面上還掛著「LLM API error 429... Retrying in 5s... (1/3)」的紅色 banner，看起來像沒重試或最後還是失敗。

**原因**: agent-loop 的 retry 會送 `sendChunk({ type: 'error', error: "...Retrying in..." })` 通知 renderer「我正在重試」。retry 成功後只送 `{ type: 'done' }`，並不會送一則「error 清掉」的 chunk。PmView 的 `done` handler 原本只 reset stream 相關 state，沒碰 `error`，導致 retry banner 殘留。

**解法**:
- chunk handling 抽成純 reducer `pmStreamReducer`（`pm-view-reducer.ts`），**任何非 error chunk** 到達時（`text` / `tool_start` / `tool_result` / `done`）都 `error = null`，把 retry banner 當作 stale state 處理。
- 單元測試放在 `pm-view-reducer.test.ts`，含三個 regression case（done / text / tool_start 各一）。

**不要改**:
- 不要把清 banner 的邏輯只放在 `done`，text chunk 先到時會讓 banner 停留到整個 turn 結束才消失，中間 UX 怪。
- 不要改成「收到 error chunk 就覆蓋 banner」去避免這問題 — final error（非 retry）已經是獨立分支，清 banner 的正確觸發點是「成功 stream 開始恢復」。

---

## 34. PM sliding window 必須回退到 user boundary，不能裸切 tool-call 序列

**現象**: PM 對話累積到 40+ turn 後突然回 `LLM API error 400: Please ensure that function call turn comes immediately after a user turn or after a function response turn.` (Gemini)。OpenAI 一般不會抱怨，但 Gemini 嚴格要求結構乾淨。

**原因**: agent-loop 原本用 `history.slice(-MAX_HISTORY_TURNS)` 機械式取最後 N 筆。如果切點剛好落在 `assistant content=null tool_calls=[...]` (function_call) 或 `tool` (function_response)，head 就是裸的 tool 序列開頭，違反 Gemini 規則 — 它要求 function_call 必須緊接在 user 或 tool 之後。

**解法**: `trimHistoryForLLM(history, maxTurns)` (`src/main/pm/history-window.ts`) 切完之後往前回退到最近的 `user` 訊息，保證 head 永遠是 user turn。代價是訊息會略多於 maxTurns，但結構合法。

**不要改**:
- 不要把回退邏輯改成「往前找直到下一個 user」(forward search) — 會丟掉切點到下一個 user 之間的 context，最近的 tool 序列直接消失。
- 不要在切完後手動補 placeholder user turn — Gemini 雖然會接受結構，但 LLM 看到憑空冒出來的 user 會困惑。
- regression test 在 `history-window.test.ts`，新增 sliding window 邊界 case 時要補測。

---

## Agent View: inferTabState 對 TUI 類 CLI 永遠回傳 cli_running

**現象**: PM Agent 的 `inferTabState` 對 Claude Code、Copilot CLI 等 TUI 程式永遠回傳 `cli_running`，無法偵測 done/idle 狀態。

**原因**: TUI 程式用 cursor positioning（ANSI escape codes）渲染，strip ANSI 後的 scrollback 文字跟原始 CLI output 完全不同，pattern matching 全部失效。

**解法**: Agent tab 用 structured state（`getAgentState()` 從 SDK session manager 直接取），Terminal tab 繼續用 scrollback heuristic。`tab-watcher.ts` 的 `resolveTabState()` 自動派發。

---

## Agent Server: 遠端 Node.js 版本

**現象**: agent-server bundle 在遠端 spawn 失敗，`SyntaxError: Unexpected token`。

**原因**: esbuild target 是 `node20`，但遠端 Node.js 版本 < 20。

**解法**: 確保遠端有 Node.js 20+。deploy 時不做版本檢查（avoid extra SSH round-trip），錯誤會在 `waitForReady` timeout 後浮現。

---

## Claude SDK: thinking.display 沒設，dev/packaged 行為會分歧

**現象**: dev (`npm run dev`) 看得到 thinking 內容，packaged app 收到 `len=0` 但 `hasSignature=true` 的 thinking block，且完全沒有 `thinking_delta` stream event。同一份 SDK config (`{ type: 'adaptive' }`)、同一支 `claude` binary、同一份 minified agent-server bundle，**僅執行環境不同**。

**原因**: Claude Agent SDK 在 spawn `claude` CLI 時，依據 `options.thinking` 推 CLI flag：

```ts
case "adaptive": l.push("--thinking", "adaptive"); break;
if (U.type !== "disabled" && U.display) l.push("--thinking-display", U.display);
```

`thinking.display` 沒設值 → SDK **不**推 `--thinking-display` → CLI 走自己的預設邏輯。

CLI 的預設邏輯**到底看什麼沒驗證**（binary 是 Bun 編譯的 native，原始碼看不到）。我們只驗證過：

- 只補 `TERM=xterm-256color` 不能修
- 進一步補 `TERM_PROGRAM`、`LC_TERMINAL`、`NODE_ENV` 等 env 沒測完就放棄這條路
- 明確設 `display: 'summarized'` 一定能修

候選 trigger 包含 env (`TERM_PROGRAM`、`NODE_ENV` 之類)、`process.stdout.isTTY`、父行程 type、`__CFBundleIdentifier`（macOS）、其他未列舉的訊號，未深究。

**解法**: `agent-server/providers/claude.ts` 明確設 `thinking: { type: 'adaptive', display: 'summarized' }`，繞過 CLI 的「我自己猜」分支，dev/packaged 行為一致。

**不要改**:
- 不要刪掉 `pathToClaudeCodeExecutable: CLAUDE_BINARY_PATH` — SDK 的 auto-resolve 在 esbuild bundled + asar packaged 環境下找不到 sibling `node_modules`，會 fallback 到 PATH 上版本可能不符的全域 `claude`。
- 不要在 packaged build 偷補 env 變數 (`TERM`、`NODE_ENV` 等) 想 workaround — 那是補在錯的層級，CLI 預設邏輯改版就壞，且我們也沒驗證 env 真的是 trigger。

---

## Claude SDK: rate-limit usage 只在接近警戒線才回真實數值

**現象**: status segment 上的「5h: N%」百分比平常顯示 `—`，只有快到 warning 才忽然出現具體數字。看起來像 bug。

**原因**: SDK 的 `SDKRateLimitInfo.utilization` 欄位只在 `status === 'allowed_warning'` 或 `'rejected'` 時才填值；`'allowed'`（一般情況）會把 utilization 整個丟掉，即使底層 `anthropic-ratelimit-unified-*-utilization` HTTP header 一直都有資料。SDK 端看似有意為之的「不在意你還很閒」設計。

`rate_limit_event` 也只在「rate limit info 有變化」時才推一次，不是每個 turn 都會收到，所以剛開新 session 連事件都沒有，segment 一片空。

**現況做法**: `rateLimitInfoToSegment()` 收到 `'allowed'` 時 fallback 顯示 `5h: — ↻3h`（bucket 名 + 倒數），讓使用者至少看得到「reset 時間」這個有用訊號。utilization 欄位只在 SDK 願意給的時候才顯示百分比。

**不要做**:
- 不要試著從別的地方算 utilization（例如自己累加 inputTokens / window 比例）—— 5h/7d 兩個 bucket 是 server-side 計算，client 沒有完整資訊。
- 不要把 fallback 改成 `5h: 0%`，那會誤導使用者以為配額沒在動。

可能改進方向（未實作）: 直接讀底層 HTTP header（`anthropic-ratelimit-*`），跳過 SDK 的 filter。但 SDK 沒暴露 raw response，要 patch SDK 或自己跑一條額外 API 拿。

**追蹤上游進度**:
- 上游 issue（含詳細 root cause + 解法草案）: https://github.com/anthropics/claude-code/issues/50518
- 同主題的 client 端 workaround PR（已 closed，未 merge）: https://github.com/agentclientprotocol/claude-agent-acp/pull/568
- 截至 2026-05 為止 issue 仍 OPEN、無任何 Anthropic 回應、無 triage label。**不要寄望短期內修復**。日後想知道現況時，先點上面 issue link 看有沒有新留言／關閉。

---

## Copilot SDK: `usedRequests` 永遠 ≤ entitlement，超出量在 `overage` 欄位

**現象**: 月配額用爆，UI 上 `premium: 100%` 死卡，怎麼跑都不會跳到 200%／300%。Type def `AssistantUsageQuotaSnapshot` 寫 `usedRequests: Number of requests already consumed`，看起來應該反映真實使用量。

**原因**: 看 `node_modules/@github/copilot/app.js` 的 quota normalization：

```js
let s = n ? 0 : Math.round(Math.max(0, o*(1-r/100)));
//      usedRequests = entitlement * (1 - percent_remaining/100)
return { entitlementRequests: o, usedRequests: s, overage: t.overage_count ?? 0, ... }
```

CLI 把上游 API 的 `percent_remaining`（自然 cap 在 0-100）反推回 `usedRequests`，所以 `usedRequests` 數學上就 ≤ `entitlementRequests`。**真實的超量計數是 `overage` 這個獨立欄位**（從 API 的 `overage_count` 來），SDK type def 也寫了「Number of requests over the entitlement limit」。

**解法**: utilization 改算 `(usedRequests + overage) / entitlementRequests`。覆蓋測試在 `agent-server/providers/copilot.test.ts`「shows overage above 100%」+「renders extreme overage like 255%」。

**不要做**:
- 不要回去用 `usedRequests / entitlementRequests` — 永遠 cap 100%
- 不要用 `1 - remainingPercentage` — 上游 API 也 cap 100%（`percent_remaining` 不會負數）
- entitlement = 0（unlimited 或缺資料）的 case 要 short-circuit return `null`，現在 code 已處理 — 不要刪掉 `isUnlimitedEntitlement` 檢查

---

## Copilot `apply_patch` tool 的 args 是裸 string，不是 object

**現象**: 想為 Copilot 的 file mutation tool 做差異化 UI（diff 預覽），照其他 tool 慣例去 `event.data.arguments.file_path` / `.old_string` 等欄位拿不到資料。trace 印出來看到 `arguments` 整個就是一坨字串，長這樣：

```
*** Begin Patch
*** Update File: /path/to/file.md
@@
-# Old
+# New
*** End Patch
```

**原因**: Copilot CLI 把所有檔案異動（Update / Add / Delete）統一走 `apply_patch` tool，args 是 unified diff 格式的字串。跟其他 tool 用 JSON object args（`view`/`bash`/`report_intent` 等）不一致，type def 沒寫清楚。

**解法**: `agent-server/providers/copilot.ts` 的 `parseApplyPatch()` 把 patch 解析成 `ApplyPatchFileSpec[]` — 每個 `*** Update File:` / `*** Add File:` section 各自一個 entry，同檔 multi-hunk（多個 `@@` block）也展成多個 entry（同 filePath 重複，每個 hunk 自己一張 file_edit 卡）。Delete 操作目前沒對應 canonical type 所以整 patch return null → fallback 成 generic `tool_use`（顯示 raw patch string）。Patch-level 失敗時所有 sub-card ✗ + 額外發一條 `msgType: 'error'` 在 timeline 顯示具體原因。

**不要做**:
- 不要假設 `apply_patch` args 是 object — 永遠先 `typeof args === 'string'` 檢查
- 不要把 raw patch string 當 toolInput 餵渲染端 — `parseApplyPatch` return null 時 wrap 成 `{ patch: <raw> }` object，避免 renderer 對 toolInput 做 `Object.values(...)` 之類操作 crash
- 不要把 Delete 從 fallback 路徑拉出來「假裝是 file_edit」— 需要時應該擴 canonical type（譬如 `file_edit` 加 `deleted?: boolean` 或新增 `file_delete` variant），不是在 parser 偷塞 sentinel

## Copilot session 必須傳 `workingDirectory`，否則 bash tool `posix_spawnp failed`

**現象**: Copilot 跑 bash tool 顯示 `Error: <exited with error: posix_spawnp failed.>`，read/grep/edit 都正常只有 bash 死。

**根因**: Copilot SDK 的 `client.createSession({...})` config 有 `workingDirectory?: string` 欄位（[types.d.ts](../node_modules/@github/copilot-sdk/dist/types.d.ts) line 1039），CLI 內建的 bash tool 用這個值當子程序 cwd。沒傳就用 CLI 自己的 cwd — agent-server 在 packaged Electron 裡 cwd 可能是 `/` 之類的怪地方，bash spawn 起來 posix 直接拒絕。

**解法**: `query()` 收到 `input.cwd` 時 stash 成 `currentCwd`，`ensureSession` 把它放進 `config.workingDirectory`：
```ts
if (input.cwd && !currentCwd) currentCwd = input.cwd;
// ...
if (currentCwd) config.workingDirectory = currentCwd;
```

**不要做**:
- 不要用 `process.cwd()` 當預設 — agent-server 的 cwd 不是用戶的專案目錄
- 不要在每個 turn 重設 currentCwd — Copilot CLI 沒有 `rpc.cwd.set`，session 中途換 cwd 改不動，只能 first-write-wins（要切 cwd 就斷 session 重建）

## Claude SDK `tool_result.content` 可能是 content-block array，不是 string

**現象**: 渲染 Claude sub-agent（`Task` / `Agent`）的 result 時，畫面顯示 raw `[{"type":"text","text":"..."}]` 而不是純文字。

**根因**: Claude SDK `assistant.message.content` 裡的 `tool_result` block，它的 `content` 欄位有兩種可能 shape：
1. 純 string（多數 SDK built-in tool: Bash/Read/Grep stdout）
2. content-block array：`[{ type: 'text', text: '...' }, ...]`（Task/Agent sub-agent 標準返回；MCP custom tool 也常用）

早期 code `typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')` 對 array case 直接 stringify，把 wrapper 結構也印出來。

**解法**: `agent-server/providers/claude.ts:extractToolResultText()` 統一展開：string passthrough、array 抽 text-block 的 `.text` 用 `\n` join、其他 shape JSON-stringify 保命。

**不要做**:
- 不要假設 `content` 一定是 string — type def 寫 `string | ContentBlock[]`
- 不要丟掉非 text block — 至少 fallback JSON 保留資訊（例如 image block）
- 不要在 renderer 端做 unwrap — provider 已經保證送出純 string，renderer 不該再做格式判斷

## Claude SDK 同時有 `Task` 跟 `Agent` 兩個 toolName 做 sub-agent dispatch

**現象**: 我們的 `formatClaudeToolInput` switch case 只 match `'Task'`，user 看到 sub-agent 卡片 header 只顯示 `description` 文字，看不到 prompt preview — 跟預期 `description: prompt-prefix` 格式不一樣。

**根因**: Claude code SDK 從某個版本開始把 sub-agent dispatch tool 從 `Task` 改名 `Agent`（兩個並存當別名）。Input shape 一樣（`{ description, subagent_type, prompt }`），但 toolName 不同。Match `'Task'` 的 case 漏掉 `'Agent'`，落到 default 分支拿 first string value（就是 `description`）。

**解法**: formatter switch 寫 `case 'Task': case 'Agent':` 共用同一個 body。

**不要做**:
- 不要假設 SDK 的 toolName 永遠穩定 — Claude code SDK 自己會 alias / rename，需要時補 case
- 不要為了「以後新 SDK 名字」加複雜 prefix-match 邏輯 — 出現時加 case，don't over-engineer

## Copilot CLI 不能放 `app.asar.unpacked`，會踩它自己的 path-replace bug

**現象**: Packaged build（任何 packaged mode）下 Copilot bash tool 每次都失敗：
```
Error: <exited with error: posix_spawnp failed.>
```
Read / Grep / Glob 等不需要起 subprocess 的 tool 都正常。Dev mode（`npm run dev`）完全沒事。

**根因**: `node_modules/@github/copilot/app.js` 內部用 `loadNativeModule("pty")` 找 native binary，然後做這條：
```js
let helperPath = bio.dir + "/spawn-helper";
helperPath = path.resolve(__dirname, helperPath);
helperPath = helperPath.replace("app.asar", "app.asar.unpacked");
helperPath = helperPath.replace("node_modules.asar", "node_modules.asar.unpacked");
```

Copilot CLI 假設 packaged Electron app 的標準路徑是 `Shelf.app/Contents/Resources/app.asar/...`，所以 replace 把 `app.asar` remap 到 `app.asar.unpacked` 來找實際 unpacked 的 native binary。

問題：JS `String.replace(string, ...)` 只替換第一個 match。當路徑**本身已經**是 `.../app.asar.unpacked/...`（因為我們用 `asarUnpack` 把 `@github/copilot/**` unpack 出來），replace 找到 `app.asar` 子字串 → 變成 `.../app.asar.unpacked.unpacked/...` → 路徑不存在 → spawn-helper 找不到 → posix_spawnp 失敗。

Dev mode 沒事是因為路徑是 `node_modules/@github/copilot/...`，不含 `app.asar` 子字串，replace 是 no-op。

**解法**: `@github/copilot` 不放 `node_modules` / `asarUnpack`，改放 `extraResources`：
```json
"extraResources": [
  { "from": "node_modules/@github/copilot", "to": "copilot-cli", "filter": ["**/*"] }
]
```
路徑變成 `Shelf.app/Contents/Resources/copilot-cli/...`，不含 `app.asar` 子字串 → upstream buggy replace 是 no-op → spawn-helper 找得到。

`resolveCopilotCliPath()` 對應改成 `path.resolve(__dirname, '..', '..', 'copilot-cli', 'index.js')`。

**語意上也更對**: Copilot CLI 是 bundled subprocess（像 ffmpeg 一起 ship 的 binary），不是 `require()`-able library。我們的 agent-server 只 `require('@github/copilot-sdk')` (JS library, 留在 asar)，從不 require `@github/copilot`，只 spawn 它當 CLI 跑。`extraResources` 才是這種 binary distribution 的正確 pattern。

**不要做**:
- 不要 patch `app.js` 把那兩條 replace 改掉 — 每次 npm install 要 reapply，npm update 會蓋掉，brittle
- 不要建 `app.asar.unpacked.unpacked` symlink 騙 buggy code — code-signing 可能踩 symlink，notarization 不穩
- 不要把 `@github/copilot-darwin-*` / `-linux-*` / `-win32-*` 拉進來 — 那是給 standalone `npm install -g @github/copilot` 用的 platform-specific binary，SDK 模式下根本不會載入（loader index.js 只 import 同目錄的 app.js）



## Slash `/compact` `/clear` 期間 stop 按鈕沒反應

**症狀**: 使用者按 `/compact` 跑了一陣子，覺得太久按 stop — 按鈕沒任何反應，要等 SDK 自己跑完。

**根本原因**: by-design。Provider 內部 `stoppable` flag 在 critical-section（compact 進行中、`/clear` 的 dispose+rebuild 期間）set 為 false，`stop()` 看到後 silently no-op。中斷會留半完成 session — Copilot CLI `rpc.history.compact()` 已發出 RPC、Claude SDK 已進入內部 compact loop，外部 abort 沒有乾淨退出語意。

**為什麼不做 UI 提示**: 不上 renderer 是有理由的（見 DECISIONS #54）— 使用者預期已對齊（compact/clear 修改 session 狀態，直覺就知道不該打斷），業界主流（Cursor / Claude Code / Aider）也都這樣。加 `stoppable` 欄位需要：協定加欄位、provider 維護 mid-turn 切換、renderer 條件 UI、跨 component 一致性處理。複雜度沒對應到痛點。

**Future 路徑**: 若使用者反映「stop 沒反應困惑」，加 `stoppable?: boolean` 到 status event payload，provider critical section 進出時 emit 切換訊號，renderer 條件 disable / 不同視覺。改動範圍小，能升級時再升級。

## Slash response 寫入後降版的相容性

**症狀** (假想): 使用者升版用了 `/compact`，slash_response 訊息存進 IndexedDB；降版回舊版 shelf 沒這 variant，載入歷史會怎樣？

**結論**: 安全 lossy degradation — 整個 conversation 載入不會崩，只是 slash_response 訊息會 silently 不渲染。

**為什麼**:
- `loadAgentMessages` 只 `.map()` row → AgentMsg，沒有 throw on unknown variant
- `reviveOrphanPending` 只認自己處理的 type（tool_use / file_edit / slash_response），其他 pass through unchanged
- `AgentMessage.tsx` render switch 有 `default: return null`（exhaustive `never` check），TS compile 時抓未對齊 variant，runtime 對未知 type 就是不渲染
- 降版的舊 code 看到 `type: 'slash_response'` 就 fall through default → return null → 從 list 上消失但不爆

**注意**: 是 lossy，不是 lossy-with-warning — 降版使用者根本不會知道有訊息被吃掉。如果這條 invariant 在未來放寬（e.g., 改成 throw on unknown），請同時調 `loadAgentMessages` 加 schema-version 紀錄。


## Claude SDK content_block_start 會 mid-turn 重發

**症狀**: 同一個 Claude assistant 回覆在 agent view 渲染成兩條相同訊息，並列堆疊。

**根因**: 之前 `agent-server/providers/claude.ts` processMessage 對 `content_block_start` 事件**永遠 overwrite** `blockMsgIds[idx]`：

```ts
// 舊版（buggy）
if (event?.type === 'content_block_start' && ...) {
  blockMsgIds.set(event.index, mintMsgId());
}
```

預期：SDK 只在新 block 開始時發 content_block_start，所以 overwrite 沒問題。
實際：SDK 在 mid-turn 對同一邏輯 block 也會再發 content_block_start（觀察到的行為，原因未追究 — 可能是 partial message resync / 內部重試）。Overwrite 會：

1. 孤兒化 renderer 已經 stream 累積的 entry（原 msgId）
2. 後續 assistant emit 用新 msgId
3. 兩個 msgId 不同 → renderer upsert 路徑分岔 → 兩條訊息同內容

**解法**（最終版，原本的「clear-on-tool_result」是錯的，見下方修正）:

- `content_block_start`：只在沒 entry 時 mint（idempotent）— 保留
- `message_start`（SDK 自己的訊號）：清空 `blockMsgIds`，這才是兩個 logical assistant message 之間的真正邊界

**為什麼不是 `tool_result`**: 第一次修這 bug 時用 `tool_result` 當邊界 clear，後來發現 SDK 在 `includePartialMessages: true` 下，**有時會在 `tool_result` 之後再發一次該 turn 的 partial assistant**（觀察到，原因未追究）。tool_result clear 後 `blockMsgIds` 是空的，這個 late partial 進到 `assistant` case 會給同一段 text mint 新 msgId → 又重複了。`message_start` 是 SDK 對「下一個 assistant message 開始」的明確訊號，沒這個 race。

**不要改**:
- 不要把 `content_block_start` 改回 always-overwrite — 那會復活原本的 bug
- 不要回到 `tool_result` 當邊界 — 那會踩 late-partial 的 race
- 不要在 `content_block_stop` / `message_stop` 做 reset — late partial 可能在 stop 之後才到


## AgentView `projectIndex` drift on project reorder

**現象**: 拖拉 sidebar 重新排序 project 後，agent view status bar 的 model / effort / permissionMode 變成別人家專案的值（或重置）。Session id、prefs 後續寫入也會錯位到別的 project。

**根因**: `App.tsx` render `AgentView` 時 `key={tab.id}`（stable）但 `projectIndex={pi}`（陣列 index）。Reorder 後：

1. `key` 穩定 → React 不會 unmount，沿用同一個 AgentView 實例
2. 但 `projectIndex` prop 改了 → 指到別人家的 project
3. `savedPrefs = projects[projectIndex]?.config.agentPrefs?.[provider]` 讀到錯誤 project
4. `Line 328-340` 的 capabilities useEffect deps 包 `savedPrefs`，下次 `onCapabilities` 抵達會用錯誤值覆蓋 status bar
5. `updateProjectConfig(projectIndex, ...)` 寫入也錯位

**解法**: AgentView 改收 `projectId: string`（stable），內部 `const projectIndex = projects.findIndex(p => p.config.id === projectId)` 每次 render 重新解析。Reorder 後 lookup 跟著走，永遠指向自己原本的 project。

**不要改**:
- 不要把 `projectIndex` 加回 props — index 對 reorder 不穩
- 不要嘗試讓 key 包含 projectId（會在 reorder 時 unmount，丟掉 timeline / streaming 狀態）


## Claude provider `sdkQuery()` 不能 re-entrant，一個 turn 只能一次

**症狀** (預期會踩到): 未來在 `dispatchSlash` 想為某個 slash command 另開一個 `sdkQuery()` 做 side effect（例如「先 query 一輪取資訊、再跑使用者 prompt」），會發現第一個 generator 被 orphan、abort controller 被踩、`pendingPermissions` map 提前清空。

**根因**: `agent-server/providers/claude.ts` 用 module-level 閉包狀態管 turn lifecycle：

- `activeQuery`（line ~281）：當前 SDK generator，single slot
- `abortController`：當前 turn 的 abort signal，`finally` 清成 null
- `pendingPermissions`：tool permission 對應 map，`finally` drain
- `blockMsgIds`：assistant block → msgId 映射，per-turn local
- `stoppable`：critical section flag

這些狀態散在 281 / 341 / 384 / 404 幾個點 set/clear，從單一函式 read 看不出全貌。第二次呼叫 `sdkQuery()` 會：

1. 覆蓋 `activeQuery` → 第一個 generator 沒人 consume，記憶體洩漏 + SDK 子程序停在半路
2. 覆蓋 `abortController` → 第一個 turn 的 stop 訊號失效
3. `finally` 跑兩次 → `pendingPermissions` 被提早清，第一輪 in-flight 的 permission resolve 找不到對應 entry

**正確 pattern**:

- Slash 需要 SDK 處理時（Claude `/compact` `/clear`）：把 slash prefix **塞進唯一一次的 `sdkQuery()`** `options.prompt`，讓 SDK 自己 dispatch。在 event stream 內 scan 完成訊號（既有實作 line 351-380 掃 `compact_boundary` / `compact_result` 就是這 pattern）。
- Slash 不需要 SDK（`/help` `/context`）：完全不 call SDK，直接 emit `slash_response`，立即發 idle status 收掉 turn。
- After-idle 重 call 可以，但前提是前一輪 `finally` 完整跑完 — 也就是必須等 `query()` return 之後才開新 SDK turn。

**不要做**:
- 不要在 `dispatchSlash` 內為了「先做一件事再跑使用者 prompt」開第二個 `sdkQuery()` — 改成單次 query 用 system prompt / pre-pended user message 達成
- 不要把 `activeQuery` 改成 array / set 想支援並發 — turn lifecycle 的其他狀態（abort / permissions）也跟著要重設計，不是小改
- Copilot 沒這個限制（`state.session.rpc.*` 可在 turn 間 call），但 mid-critical-section 仍要走 `critical()` helper
