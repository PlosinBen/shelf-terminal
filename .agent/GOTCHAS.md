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

**原因**: CI build 設了 `CSC_IDENTITY_AUTO_DISCOVERY: false`、出來的 macOS binary 沒簽名；Squirrel.Mac 要求更新包必須經 code signing。Windows 不受影響。

**現況**: 沒 Apple Developer cert（年費 $99），macOS 用戶手動下載新版。要啟用時把 cert 經 `CSC_LINK` + `CSC_KEY_PASSWORD` 帶進 CI、移除 `CSC_IDENTITY_AUTO_DISCOVERY: false`、補 notarization。

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

**注意**: 目前是明文。

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

## 29. 503/429 auto-retry 用 exponential backoff

**現象**: PM 對話撞 503 後自動重試。

**原因**: `agent-loop.ts` 對 retryable HTTP error（503/429/500/502/504）自動重試最多 3 次，間隔 5s → 10s → 20s（exponential backoff）。重試期間 UI 顯示 "Retrying in Ns..."。

**注意**: 重試期間按 Stop 可中止。全部失敗後 error 存進 history（role: 'error'），重啟後可見。

---

## 30. PM panel 和 DevTools 的 toggle 按鈕由 BottomBar 統一管理

**現象**: 修改 PM 或 DevTools 的 toggle/收合行為時，改 PmView/DevToolsPanel 沒效果。

**原因**: toggle 按鈕的渲染不在各 panel component 內。DevToolsPanel 的 `if (!devToolsVisible) return null`（不 return toggle button）。**footer 重設計後**：toggle 已從 App.tsx 的 `.right-tabs-collapsed`（已移除）搬到 **BottomBar footer-right**（沿用 `right-tab-btn` class）。

**注意**: 新增右側 panel 時要在 **BottomBar** 加 toggle 按鈕，不要在 panel component 裡加。

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

上游 issue: https://github.com/anthropics/claude-code/issues/50518

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

**解法**: `agent-server/providers/copilot.ts` 的 `parseApplyPatch()` 把 patch 解析成 `ApplyPatchFileSpec[]` — 每個 `*** Update File:` / `*** Add File:` section 各自一個 entry，同檔 multi-hunk（多個 `@@` block）也展成多個 entry（同 filePath 重複，每個 hunk 自己一張 `fold_diff` 卡 — 重構後 type 名，舊版叫 `file_edit`）。Delete 操作目前沒對應 fold variant 所以整 patch fallback → 一張 `fold_code` 卡顯示 raw patch string（舊版 fallback 成 generic `tool_use`）。Patch-level 失敗時所有 sub-card 帶 `errorMessage` + 額外發一條 `error` msgType 在 timeline 顯示具體原因。

**不要做**:
- 不要假設 `apply_patch` args 是 object — 永遠先 `typeof args === 'string'` 檢查
- 不要把 raw patch string 直接餵渲染端的 `subtitle` — `parseApplyPatch` return null 時包進 `fold_code` body，避免 header subtitle 變一坨 unified-diff
- 不要把 Delete 從 fallback 路徑拉出來「假裝是 fold_diff」— 需要時應該擴 fold union（譬如 `fold_diff` 加 `deleted?: boolean` 或新增 fold variant），不是在 parser 偷塞 sentinel

**Refactor note (DECISIONS #60)**: 渲染原語化重構後，canonical type 從 `file_edit` / `tool_use` 改為 `fold_diff` / `fold_code`；parseApplyPatch 邏輯本身（hunk 拆解、Delete fallback）不變。

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

## Claude SDK 0.3.x 把 `AskUserQuestion` deny 攔截的 `is_error:true` 透傳給 renderer

**現象**：升 SDK 0.2.126 → 0.3.159 後，AskUserQuestion picker 答完後 chat 上多了紅色「Tool returned an error」banner，但對話本身正常往下走。

**根因**：我們攔截 AskUserQuestion 用的 hack 是 `canUseTool` 返回 `{behavior:'deny', message:JSON_answer}`，SDK 把 deny.message 當 tool_result content 餵 model（spike 驗證）。Wire 層 `is_error:true` 是 deny 的副作用。
- SDK 0.2.x：tool_result 不發給 client，所以紅 banner 看不到
- SDK 0.3.x：tool_result 帶 `is_error:true` 一路 fire 到我們的 user message 處理，`emitClaudeToolResult` 看 is_error 套上 errorMessage

**解法**：`agent-server/providers/claude.ts:emitClaudeToolResult()` 特例處理 `entry.toolName === 'AskUserQuestion'`：suppressError 直接吃掉 isError，不顯示紅 banner。Model 仍然收到答案 JSON 正常往下走。

**不要做**：
- 不要把整段 hack 拆掉 — SDK 0.3.x 還是沒有 `onAskUserQuestion` callback，deny+smuggle 是目前唯一可行解
- 不要全域 suppress is_error — 真的 tool error（如 Bash 失敗）還是要顯示紅 banner
- 不要假設未來 SDK 升版這 hack 還能用 — 如果 SDK 開始檢查 deny.message 不該是 JSON，就要找新攔截點

## Claude SDK 0.3.x `TaskCreate` 的 `tool_result.content` 是人類可讀文字，不是 JSON

**現象**：用 `JSON.parse(content)?.task?.id` 解析 TaskCreate result 永遠 null，plan panel 永遠空白。

**根因**：`@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` (0.3.159) 寫的：
```ts
TaskCreateOutput = { task: { id: string; subject: string } }
```

但實際 wire format（驗證於 SDK 0.3.159 + claude-opus-4-8）是純文字：
```
Task #1 created successfully: Run typecheck
```

`#N` 的 N 就是 taskId — TaskUpdate 的 `taskId` 輸入也是 `"1"` `"2"` `"3"` 這種數字字串，跟 text 對得起來。Type def 跟 runtime 不一致是 SDK bug 或 type def 過早寫好。

**解法**：`parseTaskCreateOutput()` 先 regex 比 `/^Task\s+#(\d+)\s+created\s+successfully/i` 拿 N，失敗才退回 JSON.parse 當 defensive fallback。

**不要做**：
- 不要相信 sdk-tools.d.ts 的 Output type 一定對應 wire 格式 — 它們宣稱的是 Input 端傳遞的結構，不一定是 model 看到的 string format
- 改 parser 之前用 log dump 真實 content（前 200 字），不要 blind 改
- 跑 unit test 時測試案例要用 real wire format，不是 type def 推測的形狀

**未驗證**：`TaskListOutput` 的實際 wire 格式也可能跟 type def 不符（我們的 parser 還是用 JSON shape，因為實測未觸發）。下次看到 TaskList result 漏 reconcile 時要先 log content 確認。

## Claude SDK 0.3.142+ `TaskCreate` 的 taskId 只在 `tool_result` 才回來

**現象**：嘗試在 `tool_use` 階段就把新 task 加進 plan-panel mirror Map，發現沒辦法 key — input 完全沒有 id 欄位。

**根因**：SDK 把 TodoWrite snapshot 換成 `TaskCreate / TaskUpdate / TaskGet / TaskList` 後（0.3.142），taskId 改成 SDK 端配發：
- `TaskCreateInput = { subject, description, activeForm?, metadata? }` ← 沒 id
- `TaskCreateOutput = { task: { id, subject } }` ← id 在這
- `TaskUpdateInput = { taskId, ... }` ← 需要引用既有 id

也就是 agent 在 `tool_use` block 發出 TaskCreate 時根本還不知道 taskId 是什麼。

**解法**：provider 用兩段式 state：
1. `pendingTaskCreates: Map<tool_use_id, {subject, description, activeForm}>` — 暫存等 tool_result
2. `tasks: Map<taskId, TaskRecord>` — 正式狀態
3. tool_result 經 `extractToolResultText()` 拿到字串後再 `parseTaskCreateOutput()` JSON.parse 拿 id，搬到正式 Map

詳見 `agent-server/providers/claude.ts` (`pendingTaskCreates` / `tasks` 兩個 Map) 和 `.agent/features/sdk-upgrade-0.3.md`。

**不要做**：
- 不要嘗試從 `tool_use.input` 拿 taskId — 它真的不在裡面
- 不要相信 tool_result 一定是合法 JSON — parse 失敗時 drop pending、等下次 TaskList reconcile
- 不要在 renderer 處理 taskId — 那是 provider 內部實作細節，wire protocol 永遠只看到 `{type:'plan', content:markdown}`

## Claude SDK 同時有 `Task` 跟 `Agent` 兩個 toolName 做 sub-agent dispatch

**現象**: 我們的 `formatClaudeToolInput` switch case 只 match `'Task'`，user 看到 sub-agent 卡片 header 只顯示 `description` 文字，看不到 prompt preview — 跟預期 `description: prompt-prefix` 格式不一樣。

**根因**: Claude code SDK 從某個版本開始把 sub-agent dispatch tool 從 `Task` 改名 `Agent`（兩個並存當別名）。Input shape 一樣（`{ description, subagent_type, prompt }`），但 toolName 不同。Match `'Task'` 的 case 漏掉 `'Agent'`，落到 default 分支拿 first string value（就是 `description`）。

**解法**: formatter switch 寫 `case 'Task': case 'Agent':` 共用同一個 body。

**不要做**:
- 不要假設 SDK 的 toolName 永遠穩定 — Claude code SDK 自己會 alias / rename，需要時補 case
- 不要為了「以後新 SDK 名字」加複雜 prefix-match 邏輯 — 出現時加 case，don't over-engineer

**Refactor note (DECISIONS #60)**: 渲染原語化重構後，`formatClaudeToolInput` 的輸出餵給 `fold_code.subtitle` / `fold_diff.subtitle`，不再叫 `tool_use.input`；switch case alias 邏輯本身不變。

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

**為什麼不做 UI 提示**: by-design — 使用者預期已對齊（compact/clear 修改 session 狀態，直覺就知道不該打斷），業界主流（Cursor / Claude Code / Aider）也都這樣。詳見 DECISIONS #54。

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


## Claude SDK 0.2.126 沒有 onAskUserQuestion，靠 canUseTool deny+message 走私 answer

**現象**: SDK 把 AskUserQuestion 當普通 tool dispatch、`canUseTool` 對它觸發、但 SDK 沒提供 `onAskUserQuestion` 之類的專屬 callback。Harness 想接管這個 tool，唯一可走的 channel 是 `canUseTool` 的 `{behavior: 'deny', message}` 返回值 — `message` 內容被 SDK 包成 `tool_result.content`（即使 `is_error: true`），model 讀 content 不看 flag、解析 JSON 繼續對話。

**Spike 驗證**: `scripts/spike-askuser.ts`。SDK 升級（0.3.x、未來引入真正的 callback）時 manual `npx tsx scripts/spike-askuser.ts` 跑一次驗 hack 還 work。

**為什麼不放 unit test**: 需要真 API key + 真打 Claude（spike script 是 integration smoke 不是 CI test）。改 unit-test 要 mock 整個 SDK transport — cost 高、回報低（SDK 內部 deny→tool_result 流程改了 mock 也測不到）。

## bypassPermissions 模式下 AskUserQuestion 仍需攔截

**現象**: Claude provider 在 `bypassPermissions` 下走 DIY bypass — `canUseTool` 對所有 tool 短路 return allow（避開 SDK 的 `allowDangerouslySkipPermissions` flag）。早期版本把 bypass 短路寫在 canUseTool 入口，**順手把 AskUserQuestion 也 bypass 掉**：SDK 看到 allow → 跑 AskUserQuestion 的內建實作 → 沒 TTY → 自動 resolve 空答案 → 使用者看到 model 抱怨 "didn't come through"。

**修法**: bypass 短路必須**排在 AskUserQuestion 攔截之後**。判定原則：

- **bypass = 「跳過 tool 權限把關」** —— Bash/Edit/Write 等 SDK 內建工具不要再問
- **bypass ≠ 「跳過使用者互動 prompt」** —— AskUserQuestion 是 agent 主動發起的問答，UI 本來就該跳

實作上 canUseTool 的判斷順序：
```ts
canUseTool = async (toolName, input, opts) => {
  if (toolName === 'AskUserQuestion') return handleAskUserQuestion(...);  // ← 永遠先攔
  if (currentBypassMode) return { behavior: 'allow', updatedInput: input };  // ← bypass 在後
  // ... 一般 permission_request 流程
};
```

**未來如果加新的「使用者互動」型 tool**（例如 SDK 哪天加 `AskUserConfirm`、`AskUserSelect` 之類），同樣要排在 bypass 之前。判定方法：tool 的語意是「我需要使用者親自做決定」就要先攔；tool 的語意是「我要存取系統資源」才走 bypass 路徑。

**回歸測試**: `agent-server/providers/claude.test.ts` 的 "AskUserQuestion intercept survives bypassPermissions" 段。

## `SHELF_TEST_MODE` 等 runtime env flag 不會自動帶到 agent-server subprocess

**現象**: E2E 把 `SHELF_TEST_MODE=1` 透過 `electron.launch({ env })` 注入 Electron process，期望 agent-server subprocess 也吃得到 → 結果 fake provider 沒被 hijack、agent-server 還是嘗試起 Claude/Copilot backend。

**原因**: `spawnAgentServer()`（`src/main/agent/remote.ts`）用的不是 `process.env`，是 `getShellEnv()` 回傳的「import 那一刻 cache 的 login-shell env」（`src/main/connector/shell-env.ts`）。Login shell 是用 `execFile` 在 import time 跑出來的、跟 Electron 自己的 process.env 是兩個世界，所以 Electron launch 時才設的 flag 看不到。

**修法**: 顯式從 `process.env` 撈出來覆蓋進 spawn env：

```ts
// remote.ts spawnAgentServer 'local' 分支
const env: Record<string, string> = { ...getShellEnv() };
if (process.env.SHELF_TEST_MODE) env.SHELF_TEST_MODE = process.env.SHELF_TEST_MODE;
const proc = spawn('node', [deployedPath], { cwd, env, stdio: [...] });
```

**判斷原則**: 任何「runtime 才決定、跟 user login shell 無關」的 env flag（測試開關、debug toggle、CI 標記），都要照這個 pattern 顯式 forward；遠端 `ssh` / `docker` 分支同理（要的話包進 `env` arg 或 shell prefix）。**user-config 性質的**（`PATH`、`SHELL`、`LANG`）才放心交給 `getShellEnv()` 全帶。

## Agent send payload 用 intent，不用 actual

**現象** (修復前): 使用者把 model 從 `opus` 切到 `sonnet` 試試看，發現太慢又切回 `opus`。但因為 backend 在 `sonnet` 時 fallback 過某個 model 上限，下次送訊息 `prefs.model` 莫名變回 fallback 結果，不是使用者期望的 `opus`。

**原因**: 重構前 `AgentView.handleSend` 的 `prefs.model` 是讀 `statusModel`（display state，從 capabilities event 寫入 = backend reported）。Backend 的 fallback 結果蓋掉 statusModel 後，handleSend 自然帶 fallback 值出去。

**修法**: PR 8 把 send payload 改成讀 `projectConfig.agentPrefs[provider]`（intent，由使用者透過 cycle / `/model` / config picker 寫入）。`store.actual*` 只用在 StatusBar 顯示、vision-capability 檢查、localPicker initial selection。**不能用在 send 路徑**。

**判斷原則**:
- 任何「下次跟 backend 互動要送什麼」→ 讀 intent（projectConfig.agentPrefs）
- 任何「現況顯示給使用者看」→ 讀 actual（store.actualModel / actualEffort / actualPermissionMode）
- 兩條線本來就應該獨立 — actual 不該回灌進 intent（reconnect bug 也是同個 root cause）

## Provider session-stateful caps 需要 init 時帶 intent

**現象**: Copilot tab 在 status bar 把 permission mode 從 ask 切到 bypass，disconnect 後 reconnect 又變回 ask。projectConfig.agentPrefs 裡值還在。

**原因**: `AGENT_INIT` → `backend.getCapabilities()` 沒帶 intent，agent-server 的 copilot provider 用 closure `currentPermissionMode = 'default'` 回報，renderer 的 `actualPermissionMode` 被 caps event 覆蓋（`agentTabStore.ts:634` "Backend-reported actuals overwrite — no fallback to intent"）。intent 原本只在 `AGENT_SEND` 才推給 backend，所以實際生效要等使用者送下一則 prompt。

**修法**: `agent:init` opts 帶 `intent: savedPrefs`，main `startSession` 轉給 `backend.getCapabilities(cwd, customModels, intent)`，remote.ts 寫進 `get_capabilities` line，copilot.ts 的 `gatherCapabilities` 在 `buildCapabilities()` 之前用 `intent.{model,effort,permissionMode}` seed closure。Claude provider 不報 `current*`，intent 可以忽略。

**判斷原則**: Provider 只要在 caps event 報任何 `current*`，就**必須**讓 init 時的 intent 影響該值。否則 backend 的 hardcoded default 會在每次 reconnect 蓋掉 renderer 的 saved intent。新 provider 加 `currentX` 欄位時記得同步擴 `gatherCapabilities` 的 intent 處理。

## WSL agent-server spawn 必須走 login shell

**現象**: Packaged Windows app 開 WSL project 的 agent view，agent-server 啟動成功（ready signal 收到）但 query 時 Claude SDK 報 `Native CLI binary for linux-x64 not found`。

**原因**: 兩個問題疊加：
1. `spawn('wsl.exe', ['-d', distro, '--', 'node', path])` 直接跑 `node`，不經過 login shell → `.bashrc` / `.zshrc` 的 `PATH` / env 不會載入
2. Windows build 只打包 `claude-agent-sdk-win32-x64`，WSL 裡跑時 `resolveClaudeBinary()` 找不到 `linux-x64` binary → SDK 嘗試 PATH fallback 但因 #1 PATH 不完整也找不到

**解法**:
1. WSL spawn 改 `wsl.exe -d distro -- sh -lc 'exec node <path>'`（login shell，載入 profile）
2. CI Windows build 額外 `npm install --force --no-save @anthropic-ai/claude-agent-sdk-linux-x64`，打包時包進 `app.asar.unpacked`

**不要做**:
- 不要把 `claude-agent-sdk-linux-x64` 加進 `package.json` dependencies — `os: linux` 限制會讓 macOS CI fail
- 不要在 `resolveClaudeBinary()` 加 `which claude` fallback — 正確打包就不需要 fallback

## agent-server handleSend 的 error 必須帶 turnId

**現象**: agent-server query 階段出錯，renderer 的 agent view 空白無回應（沒顯示錯誤訊息）。Log 顯示 `non-lifecycle event missing turnId, dropping: type=error`。

**原因**: `handleSend()` 裡的 early error path（`Missing prompt or cwd`、`getBackend()` throw）和外部 `.catch` block 用 raw `send()` 而不是 turnId-stamped wrapper。`turnAware` wrapper 在 early return 之後才建立，所以 error 沒帶 turnId → turn-dispatcher 無法路由 → 靜默丟掉。

**解法**: `handleSend` 頂部立刻建立 `turnSend = wrapSendForTurn(msg.turnId ?? newTurnId(), send)`，所有 error path 用 `turnSend`。外部 `.catch` block 從 `msg.turnId` 手動帶。

**不要做**:
- 不要在 turn-dispatcher 加「沒 turnId 就分配給 currentTurn」的 fallback — 那會復活跨 turn 串擾的 bug（DECISIONS #53 的原始問題）

## ai-sdk v6 ModelMessage schema 拒收 PM 的 OpenAI-style tool messages

**現象**: PM 第一輪走 tool（譬如 `read_global_note`）拿到 tool result 進第二輪 streamText 時撞：
```
AI_InvalidPromptError: The messages do not match the ModelMessage[] schema
```
Zod errors 指向：
- assistant message `content: null` 不被接受
- tool message `content: '...'` 不被接受（要 array）
- `tool_calls` 欄位不在 schema 內

**根因**: PM 內部 `ChatMessage` 用 OpenAI Chat Completions 老 wire 格式（`{role:'assistant', content:null, tool_calls:[...]}` + `{role:'tool', content:'string', tool_call_id}`）。`ai` package 從 v5 升到 v6 後 ModelMessage zod schema 變嚴：
- `assistant.content` 必須是 `string` 或 `Array<TextPart | ToolCallPart | ...>`
- `tool.content` 必須是 `Array<ToolResultPart>`
- tool call 改成 content-block `{type:'tool-call', toolCallId, toolName, input}`
- tool result 改成 content-block `{type:'tool-result', toolCallId, toolName, output:{type:'text', value:'...'}}`，**`toolName` 是 required**

老 code `streamText({ messages: messages as any })` 用 `as any` 過 TS 編譯但 runtime zod 抓得到。

**解法**: `src/main/pm/llm-client.ts` 加 `toModelMessages()` adapter，PM 內部仍用既有 ChatMessage 結構（history-store 不動 = 無 migration），在送進 ai-sdk 前轉成 ModelMessage：
- system message 抽出走 `streamText({ system, messages })` 的 `system` 欄位（順便消除「prompt-injection 風險」warning）
- assistant text + tool_calls 合併成 content array
- tool result 包成 `[{type:'tool-result', ...}]`
- 追蹤 `toolCallId → toolName` map 補 tool result 必填的 `toolName`；history 被 sliding window 切掉前置 assistant 時 fallback `'unknown'`

**驗證**: `src/main/pm/llm-client.test.ts` 13 test case 守 adapter 行為 — system 抽取、tool_calls 轉換、孤兒 tool result、JSON arg parse 失敗 fallback、空 content fallback、multi-round tool sequence。

**不要做**:
- 不要把 PM 內部 ChatMessage 直接改成 ModelMessage 結構 — history-store 已持久化舊格式，會破壞 backward-compat（user 既有 pm-history.json 全廢）
- 不要在 ChatMessage 加 `toolName` 欄位「為了通過 schema」— adapter 從前一個 assistant 推就好，PM 自己的內部格式越保守越好
- 不要 import `ai-sdk/openai` 的 message converter helper 自動處理 — 那會把 PM 的 ChatMessage 拉成 ai-sdk private contract，等於放棄「PM 內部格式跟 SDK 解耦」的隔離

**升 ai-sdk 時的監測點**: 任何「ModelMessage schema 變嚴」的 changelog 條目都要重跑 `llm-client.test.ts`。如果 ai-sdk 進一步要求 (e.g. tool result 加新 required 欄位)，adapter 也要同步加。

## Ollama: model 看似支援 tool_call、實測只吐 JSON text

**現象**: PM 切到 ollama provider + 選 `qwen2.5-coder:7b`/`:14b`，PM 的 10 個 tool 全部失效。Assistant 回覆變成 raw JSON 字串：
```
{"name": "read_terminal", "arguments": {"tab_id": "..."}}
```
PM 把它當 plain assistant message 顯示，沒觸發任何 tool 執行。

**根因**: `@ai-sdk/openai` 的 `streamText` + ollama `/v1/chat/completions` + qwen2.5-coder 系列實測：model 不走 native function calling，**把 tool call 直接當 plain text token 串流出來**。`fullStream` 沒 `tool-call` event，全是 `text-delta`。非 streaming (`generateText`) 也一樣 — 不是 streaming 問題，是 model 本身行為。

**矩陣**（測試於 ollama localhost:11434 + `@ai-sdk/openai`，`scripts/spike-ollama.ts`）:

| Model | tool-call event | 結論 |
|-------|----------------|------|
| **qwen3:8b** | ✅ proper event + reasoning stream | **PM 可用**（預設 model） |
| qwen2.5-coder:7b | ❌ JSON-as-text | PM 廢 |
| qwen2.5-coder:14b | ❌ JSON-as-text | PM 廢（size 大也救不了） |

ollama 官方 [tool support blog](https://ollama.com/blog/tool-support) 列 qwen2.5 為支援，實測不符 — 可能是 chat template / Modelfile 設定問題、或 ollama 的 `/v1` adapter 對某些 model 沒接通 native tool_call 路徑。未深究上游。

**解法**: 不在 code 端擋。SettingsPanel 對 ollama provider 顯示靜態 hint：「PM Agent needs native tool_call support. Verified working: qwen3:8b. Some models (qwen2.5-coder) claim support but emit JSON-as-text.」Model 列在 dropdown 是事實陳述（user 已 pull），能不能跟 PM 配合是 user 自選 model 的責任。

**驗證資產**: `scripts/spike-ollama.ts` — 升級 `@ai-sdk/openai` 或 ollama 後 manual 跑一次（`npx tsx scripts/spike-ollama.ts`）re-validate；新增 verified model 時加進 `MODELS` 陣列重跑。

**不要做**:
- 不要在 renderer 端 parse JSON-as-text 救回 tool_call — 那等於在 wrong layer 補 model 的缺陷，且 stream 中途 JSON 不一定完整、容易踩 quoting/escape 邊界
- 不要在 PM_PROVIDERS 維護「verified models」清單再去 filter dropdown — model list 本來就是 user pull 出來的事實，filter 等於說謊；hint 引導更誠實
- 不要在 typecheck/test 內 mock ollama 行為 — 上游真的可能改，spike script 留著手動驗才是對的訊號來源
