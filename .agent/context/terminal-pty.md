---
type: context
title: Terminal & PTY
related:
  - architecture/terminal-io
  - architecture/connection-lifecycle
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

**Decision**：`LocalUnixConnector.createShell()` spawn pty 時把 `HISTFILE=/dev/null` 塞進 env。每個 tab 的 shell process 只保留 in-memory history（↑↓ 在當前 session 內仍可叫回剛跑的指令），但不寫檔、不共享、關 tab 就沒。

**Reason（為什麼不直接用 user 的 `~/.zsh_history`）**：
- Shelf 把 project 當 working context；多個 project 共用同一個 history file 會洩漏「我剛在哪個 project 跑了什麼」的狀態。
- 多 tab 並開時，A tab 跑的指令污染 B tab 的 ↑（zsh `share_history` / inc_append 行為）。
- 使用者實際 workflow：以 session 內微調指令重跑為主，少用 `history | grep xxx` 翻舊紀錄。

**Reason（為什麼不寫 per-project history file）**：
- 多一個檔案要管（mkdir、project 刪除 cleanup、備份範圍）。
- 為了極少使用的 cross-session 翻舊紀錄需求增加架構複雜度，不值得。
- 若之後有人需求，HISTFILE 從 `/dev/null` 改成 `userData/shell-history/<projectId>.history` 是一行改動，model 相容。

**Background（範圍）**：
- Phase 1：只 `local/unix`（macOS / Linux 的 bash / zsh）。
- Phase 2 候補：`local/win32`（PowerShell 用 PSReadLine，要 `Set-PSReadLineOption -HistorySavePath`）、`wsl`、`ssh`（遠端 history，要 ssh remote exec 注入，corner case 多）。

**Do not change casually because**：不要回到 `getShellEnv()` 直接傳（會繼承使用者 `HISTFILE` 設定）。

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

**Root cause**：React 在 `projects.map()` 順序改變時會 unmount/remount TerminalView。remount 時 `initializedRef` 重置為 false，導致 `term.open(newContainer)` 被第二次呼叫。xterm.js 不支援 `open()` 重複呼叫，terminal 進入壞狀態。

**Fix**：在 `terminalCache` 加 `opened: boolean` flag。首次 mount 正常呼叫 `term.open(container)`；remount 時改用 `container.appendChild(term.element)` 把已有的 DOM 搬過去，不呼叫 `open()`。搬移後重新載入 WebglAddon（canvas 移動可能觸發 context loss）。WebGL context loss 的 handler 也要自動 reload addon（`dispose()` + `setTimeout(() => loadWebgl(term), 100)`），否則會 fallback 到 DOM renderer 導致畫面異常。

## terminal-pty#8 — Unicode11Addon 導致 tab completion 字元重複  ·  [Gotcha]

**Symptom**：在 terminal 輸入任意字元後按 Tab 觸發 shell autocomplete 列表時，已輸入的字元會重複顯示（如輸入 `ca` 顯示 `caca`）。實際送進 shell 的指令是正確的，只是顯示問題。

**Root cause**：xterm.js Unicode11Addon 把 Ambiguous width 字元（如 prompt 中的 `→` U+2192）當 width 1，但 zsh 可能當 width 2。Tab completion 時 shell 根據自己的寬度計算重繪命令行，游標位置與 xterm 不同步，導致字元偏移重複。這是 xterm.js 的已知限制（[#1453](https://github.com/xtermjs/xterm.js/issues/1453)、[#4753](https://github.com/xtermjs/xterm.js/issues/4753)）。

**Fix**：Unicode11Addon 仍然載入（註冊可用版本），但預設不啟用（`unicode.activeVersion` 保持預設 `'6'`）。使用者可在 Settings 開啟「Unicode 11」選項，啟用後即時生效。啟用 Unicode 11 可改善較新 emoji 和部分 CJK 字元的寬度判定，但只要 prompt 含有 Ambiguous width 字元就可能觸發此問題。
