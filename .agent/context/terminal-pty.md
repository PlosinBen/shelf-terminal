---
type: context
title: Terminal & PTY
related:
  - architecture/terminal-io
  - architecture/connection-lifecycle
  - context/external-url-intent
  - context/connector
  - context/file-transfer
  - context/settings-config
---

# Terminal & PTY

> TerminalView ↔ node-pty 的 spawn / render / 通知 / xterm.js 整合 —— 誰負責開 pty、shell history 隔離、以及 xterm.js 與 native module 的踩雷。

## terminal-pty#1 — TerminalView 是唯一 spawn 點  ·  [Decision]

**Decision**：只有 `TerminalView` 的 useEffect mount 時呼叫 `pty.spawn`。Event handler（NEW_TAB、CONNECT_PROJECT）只負責 `addTab()`。

**Reason**：之前 event handler 和 TerminalView 都 spawn，導致每個 tab 被 spawn 兩次。

**Do not change casually because**：如果在 event handler 也 spawn，會跟 TerminalView mount 重複。

## terminal-pty#2 — Local shell HISTFILE=/dev/null：tab 間 history 完全隔離、不持久化  ·  [Decision]

**Superseded by terminal-pty#10.**

## terminal-pty#3 — node-pty 需要 electron-rebuild  ·  [Gotcha]

**Symptom**：`pty.spawn` 報 `posix_spawnp failed` 或 native module 版本不符。

**Root cause**：node-pty 是 native module，npm install 時編譯的是 Node.js 版本，不是 Electron 的 Node。

**Fix**：`postinstall: electron-rebuild`，CI 上需要 Python + setuptools for node-gyp。

## terminal-pty#4 — Idle Notification 需要使用者輸入 + 5 秒門檻  ·  [Gotcha]

**Symptom**：快速指令（如 `ls`）或 agent CLI（Claude Code、Copilot）的背景輸出不會觸發通知。

**Root cause**：兩個條件都要滿足：(1) `userInput = true` —— 只有使用者透過鍵盤輸入（`writePty`）才標記，agent 自行產生的 pty output 不算。(2) `MIN_ACTIVE_MS = 5000` —— output 必須持續 5 秒以上。

**Fix**：這是 intentional —— 避免 agent CLI 背景輸出不斷觸發通知。

## terminal-pty#5 — TerminalView 的 paste/drop handler 是 closure，settings 要走 ref  ·  [Gotcha]

**Symptom**：改了 Settings 的 Max Upload Size 後，已經開著的 tab 還是用舊的上限。

**Root cause**：paste/drop listener 在 `useEffect([tabId])` 裡綁一次就不再重綁，閉包抓的是 mount 當下的 `settings.maxUploadSizeMB`。

**Fix**：`TerminalView` 用 `maxUploadMBRef = useRef(settings.maxUploadSizeMB)` 並在每次 render 同步 `.current`，handler 內讀 `.current` 而非閉包變數。`connection` 與 `cwd` 不會在 tab 生命週期內變動，仍然走閉包即可。

## terminal-pty#6 — xterm.js 6.0 pre-minified bundle 不能被 esbuild 二次 minify  ·  [Gotcha]

**Symptom**：Production build 的 terminal 執行 vim、claude 等 TUI app 時卡住無回應。DevTools 顯示 `ReferenceError: i is not defined` at `requestMode`。

**Root cause**：`@xterm/xterm@6.0.0` 出廠就是 minified 的 ESM bundle。Vite 預設用 esbuild 再次 minify 時，破壞了 `requestMode()`（DECRPM handler）裡 closure 捕獲的變數 `i`。這個 crash 發生在 write buffer 的 `_innerWrite` 裡，導致後續所有 pty 資料處理中斷。見 [xtermjs/xterm.js#5800](https://github.com/xtermjs/xterm.js/issues/5800)。

**Fix**：`vite.config.ts` 設 `build.minify: 'terser'`。terser 不會破壞已 minified 的 closure。`npm run dev` 不 minify 所以不會觸發此問題，只有 production build 會；如果升級 xterm.js 到修復此問題的版本，可以改回 esbuild。

## terminal-pty#7 — xterm.js open() 只能呼叫一次，remount 要移動 DOM  ·  [Gotcha]

**Symptom**：拖曳排序 project 後 terminal 變黑屏。

**Root cause**：TerminalView 在任何 component remount 後 `initializedRef` 都會重置為 false，若把它當成首次建立就會再次呼叫 `term.open(newContainer)`。xterm.js 不支援 `open()` 重複呼叫，terminal 會進入壞狀態。Project mounted-view identity 會避免無關 collection mutation 造成 remount，但 TerminalView 本身仍須能安全處理其他合法 remount。

**Fix**：在 `terminalCache` 加 `opened: boolean` flag。首次 mount 正常呼叫 `term.open(container)`；remount 時改用 `container.appendChild(term.element)` 把已有的 DOM 搬過去，不呼叫 `open()`。搬移後重新載入 WebglAddon（canvas 移動可能觸發 context loss）。WebGL context loss 的 handler 也要自動 reload addon（`dispose()` + `setTimeout(() => loadWebgl(term), 100)`），否則會 fallback 到 DOM renderer 導致畫面異常。

## terminal-pty#8 — Unicode11Addon 導致 tab completion 字元重複  ·  [Gotcha]

**Symptom**：在 terminal 輸入任意字元後按 Tab 觸發 shell autocomplete 列表時，已輸入的字元會重複顯示（如輸入 `ca` 顯示 `caca`）。實際送進 shell 的指令是正確的，只是顯示問題。

**Root cause**：xterm.js Unicode11Addon 把 Ambiguous width 字元（如 prompt 中的 `→` U+2192）當 width 1，但 zsh 可能當 width 2。Tab completion 時 shell 根據自己的寬度計算重繪命令行，游標位置與 xterm 不同步，導致字元偏移重複。這是 xterm.js 的已知限制（[#1453](https://github.com/xtermjs/xterm.js/issues/1453)、[#4753](https://github.com/xtermjs/xterm.js/issues/4753)）。

**Fix**：Unicode11Addon 仍然載入（註冊可用版本），但預設不啟用（`unicode.activeVersion` 保持預設 `'6'`）。使用者可在 Settings 開啟「Unicode 11」選項，啟用後即時生效。啟用 Unicode 11 可改善較新 emoji 和部分 CJK 字元的寬度判定，但只要 prompt 含有 Ambiguous width 字元就可能觸發此問題。

## terminal-pty#9 — node-pty prebuild `spawn-helper` 必須有 executable bit  ·  [Gotcha]

**Symptom**：本機 terminal tab 開啟時 `pty:spawn` handler 報 `Error: posix_spawnp failed`，stack 在 `node_modules/node-pty/lib/unixTerminal.js` 的 `pty.fork(...)`。shell 與 cwd 都存在，直接用同一個 `/bin/zsh -l` 也正常。

**Root cause**：`node-pty` 的 Unix prebuild 會呼叫 `prebuilds/<platform>-<arch>/spawn-helper`；如果 npm 解包後該檔案變成 `0644`（沒有 executable bit），macOS 會拒絕執行 helper，node-pty 只回拋泛化的 `posix_spawnp failed`。

**Fix**：`postinstall` 在 `electron-rebuild` 後跑 `scripts/ensure-node-pty-helper-mode.cjs`，對目前平台的 prebuild helper 與 source-build `build/Release/spawn-helper` 補上 executable bit。若本機已壞，直接跑同一支 script 可修復當前 checkout 的 `node_modules`，重啟 app 後生效。

## terminal-pty#10 — History 以 project 與 target host 為邊界，只隔離 zsh/bash  ·  [Decision]

**Decision**：Shelf 只對自己啟動的第一層 command interpreter 套用 history policy。Target 的 default-shell basename 是 `zsh` 或 `bash` 時，使用 `$HOME/.shelf/apps/<appId>/projects/<projectId>/shell-history/<shell>`；同 project 的 tabs 共用 namespace，不同 project 不互相污染。PowerShell、`sh` 與其他 shell 維持 native history；這只表示沒有 isolation guarantee，不降低 terminal support。使用者之後手動開 nested shell、tmux、SSH 或 container 不在 Shelf 控管範圍。

**Reason**：history 是執行 shell 所在 host 的原生資料；放在 target home 保留 SSH/WSL/Docker 的一般直覺，也避免 client-side sync/merge。只額外支援可驗證的 zsh/bash，才能避免把 `HISTFILE` 誤宣稱為所有 Unix shell 的通用隔離協定。

**Do not change casually because**：不要用 app OS 或 connector type 猜 shell，也不要因 history isolation 不支援或未確認就拒絕一個原本可用的 target。

### Gotchas
- Zsh 透過 app-level、immutable、versioned one-file `ZDOTDIR/.zshenv` shim；每個 session 的 project path/nonce 只走 env。Bash 不產生 shim，透過 launch-time `HISTFILE` 與 one-shot `PROMPT_COMMAND`。
- Project delete 先 durable commit，再 teardown project sessions 並等 bounded exit ack，最後才刪 target history；否則 live shell exit 可能把已刪 history 重建。失敗只保留 current-session retry snapshot，不建立 durable queue。

## terminal-pty#11 — Terminal 初始化由 main state machine 控制，renderer 只投影 phase  ·  [Decision]

**Decision**：main 擁有 runner initialization、hidden output、`initScript`、`tabCmd` 與 input gate。Runner 階段全局 cover；受支援 runner 執行 `initScript` 時 terminal output 可見但只接受 Ctrl+C；`tabCmd` 寫入後即 ready，不等待長命令結束。Blocked input 直接丟棄，不在 ready 後 replay。NativeRunner 只能保證 initScript/tabCmd 的 atomic write ordering，不能宣稱知道未知 interpreter 的 command completion。

**Reason**：renderer、paste 或其他 IPC caller 都會到達同一個 main boundary，才能避免繞過 phase gate。`initScript` 是 Shelf 代替使用者執行的 project-wide setup；在 zsh/bash hook 中內部執行可保留環境變動與可見輸出，又不把 setup 本身寫入 command history。

**Do not change casually because**：不要用 prompt text 或固定 sleep 猜 ready。OSC frame 必須綁 session nonce + expected phase；ready 後任何 matching-looking bytes 都應回到 normal display path。

## terminal-pty#12 — zsh shim hash 工具的輸出欄位不同  ·  [Gotcha]

**Symptom**：macOS 或 Linux 已成功放置且內容正確的 zsh shim，仍被判定 installation failure，terminal 因而降級到未隔離 native launch。

**Root cause**：`sha256sum` / `shasum` 的 hash 是第一欄，`openssl dgst` 的 hash 是最後一欄；共用 `awk '{print $NF}'` 會把前兩者的檔案路徑當 hash。

**Fix / note**：先用 `command -v` 選 utility，再依 utility 格式取第一欄或最後一欄。驗證必須用真實 POSIX command + tempfile 回歸，不只 mock command string。
