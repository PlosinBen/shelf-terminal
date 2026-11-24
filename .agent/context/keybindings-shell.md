---
type: context
title: Keybindings & Shell
related:
  - architecture/terminal-io
  - context/terminal-pty
  - context/settings-config
---

# Keybindings & Shell

> App 快捷鍵如何在 capture phase 贏過 xterm，以及 window/menu shell 行為（外部連結、DevTools 入口、IME composition）。

## keybindings-shell#1 — App 快捷鍵在 Capture Phase 攔截 + stopPropagation  ·  [Decision]

**Decision**：`useKeybindings` 在 window capture phase 監聽 keydown。匹配到已註冊的快捷鍵後執行 action 並 `preventDefault` + `stopPropagation`，事件不會到達 xterm。

帶參數的快捷鍵 action 採 `action_param` 命名，例如 `switchTab_3`。

Web 分頁內的網頁使用獨立 WebContents。焦點在網頁內時，main 從 guest 的 `before-input-event` 接收 macOS 的 Cmd+1～9 或 Windows/Linux 的 Ctrl+1～9，經 `IPC.WEB_SWITCH_TAB` 將分頁編號送回主視窗，由 `useKeybindings` 依目前專案的分頁順序切換。

**Reason**：xterm 會攔截大部分鍵盤事件（包括 Ctrl+D、Ctrl+T 等）。用 capture phase + stopPropagation 確保 app 快捷鍵優先於 xterm。新增快捷鍵只需在 types + defaults + useKeybindings 註冊，不需要改 TerminalView。

**Do not change casually because**：如果讓 xterm 先收到事件再判斷要不要放行，每新增一個快捷鍵都要同步改 TerminalView 的 `attachCustomKeyEventHandler`。

**Exception**：Windows/Linux 的 Ctrl+V（paste）和 Ctrl+C（copy when selected）不是 app 快捷鍵，是瀏覽器原生行為。這兩個在 TerminalView 的 `attachCustomKeyEventHandler` 裡 return false 讓瀏覽器處理（見 `keybindings-shell#3`）。

## keybindings-shell#2 — App 快捷鍵 Capture Phase + stopPropagation  ·  [Gotcha]

**Symptom**：快捷鍵（如 ⌘D、Ctrl+D）在 terminal 有 focus 時沒反應，或同時觸發 terminal 行為。

**Root cause**：xterm.js 在自己的 keydown handler 裡處理鍵盤事件，比 bubble phase 更早。

**Fix**：`useKeybindings` 在 window capture phase 攔截，匹配到 app 快捷鍵後 `stopPropagation`，xterm 完全收不到。新增快捷鍵只需在 types + defaults + useKeybindings 註冊。見 `keybindings-shell#1`。

## keybindings-shell#3 — Windows Ctrl+V/C 需要 Custom Key Event Handler  ·  [Gotcha]

**Symptom**：Windows/Linux 上 Ctrl+V 貼上、Ctrl+C 複製無效。

**Root cause**：xterm.js 預設把 Ctrl+V 當作 `\x16`、Ctrl+C 當作 `\x03` 送進 pty。這兩個不是 app 快捷鍵（不在 useKeybindings 裡），所以 capture phase 不會攔截它們。macOS 用 Cmd+V/C 不受影響。

**Fix**：在 TerminalView 用 `term.attachCustomKeyEventHandler()` 對非 Mac 平台攔截 Ctrl+V 和 Ctrl+C（有選取時），return `false` 讓瀏覽器處理。

## keybindings-shell#4 — Renderer 外部連結保留來源並交給 app-level intent gate  ·  [Gotcha]

**Symptom**：在 renderer 放 `<a href="https://...">` 沒加 `target="_blank"`，點下去整個 app window 跳到那個網址，terminal state 全失。

**Root cause**：Electron 預設沒有區分內部/外部連結；而 main 的 `setWindowOpenHandler` / `will-navigate` defense path 無法可靠推回 renderer 當下的 project/tab。只在 main 依 active project 猜來源會在 tab switch race 下歸錯 owner。

**Rule**：
- renderer capture listener 保留 `<a>` 的原始 href 與 owning Agent/Notes source，送 Link Open Gate；預設 Shelf 內開啟，明確 external 才送外部 FIFO gate。原事件一律阻止，不依 active project 猜來源。
- renderer 所有 `<a href="http(s)://...">` 仍加 `target="_blank" rel="noopener noreferrer"`，讓未經 capture 的 defense path 不會帶走 app window。
- 不要在 renderer 用 `window.location = url` 跳外部網址。
- 需要程式化開外部連結時，送 typed external-URL intent；只有 central gate 在使用者選 Open 後可呼叫 default-app side effect。

**Do not change casually because**：不要拿掉 main 的 `setWindowOpenHandler` / `will-navigate` defense，也不要略過 gate 的 scheme allowlist（只放 HTTP(S)/mailto）。`browser_open` 是開 Shelf Web tab 的另一份安全契約，不可混用。見 `external-url-intent#1`、`external-url-intent#3`。

## keybindings-shell#5 — Win/Linux DevTools 寫死在 main，刻意不走 renderer keybinding  ·  [Gotcha]

**Symptom**：Win/Linux 沒有選單列（為消除 Alt 撕裂感，`createWindow → win.removeMenu()`），但 F12 / Ctrl+Shift+I 仍能開 Chromium DevTools。

**Root cause**：DevTools 原本靠選單 `role: 'toggleDevTools'` 提供 accelerator，removeMenu 後會一起失效。改在 main 的 `before-input-event` 用 `isDevToolsKeyEvent`（`devtools-guard.ts`）攔 F12 / Ctrl+Shift+I → `webContents.toggleDevTools()`。

**Why it doesn't double-trigger**：三平台都接線。Win/Linux 選單已移除，main 是唯一 handler。macOS 選單的 toggleDevTools accelerator 是 **Cmd+Alt+I**，跟 F12 / Ctrl+Shift+I 不撞，所以 mac 上是「純加法」（多了 F12/Ctrl+Shift+I 兩個入口），不會 toggle 兩次互相抵消。

**Do not change casually because**：
- **不要「統一」改走 renderer keybinding 系統** — DevTools 是 renderer 壞掉時的逃生口，走 renderer keybinding 會「renderer 一死快捷鍵也死」。main 的 input 層不受 renderer 影響，這是刻意設計。
- **predicate 不要加 Cmd+Alt+I** — 那是 mac 選單已綁的，加了才會在 mac 雙觸發。維持只配 F12 / Ctrl+Shift+I。
- ⚠️ 易混淆：renderer 的 `toggleDevTools` keybinding（mod+shift+d）開的是 app 自己的 **DevToolsPanel**，不是 Chromium DevTools，同名但無關。

## keybindings-shell#6 — 攔方向鍵/Enter 的 keydown handler 必須擋 IME composition，否則中文選字壞掉  ·  [Gotcha]

**Symptom**：在面板的 free-text input 打中文，按 ↑/↓ 選字候選時，**被拿去切換選項**（還順手 blur 掉 input），無法選字；按 Enter 變成提前送出。

**Root cause**：面板用 `window.addEventListener('keydown', …, true)`（capture phase，要贏過 xterm/全域 combo）或元件 `onKeyDown` 攔 ArrowUp/Down/Enter 做選項導航。**IME 組字期間**，候選視窗就是靠這些鍵驅動 —— 若 handler 沒先看 `isComposing` 就 `preventDefault` + 改 state，等於把鍵從 IME 手上搶走。

**Fix**：handler **最前面**統一 `if (isComposing) return`（native event 用 `e.isComposing`；React SyntheticEvent 用 `e.nativeEvent.isComposing`），整組候選驅動鍵（方向、Enter、Space、Esc）一律讓 IME 先吃。把決策抽成純函式（`decidePickerKey` / `decideCommandPickerKey`）讓這條規則可單測。**只擋「有 focus 可編輯元素」的面板** —— 像 FolderPicker 那種「全域逐字攔截、沒有 `<input>`」的就沒有 composition、不適用。已套：`PickerPanel`（AskUserQuestion）、`CommandPicker`、`QuickNoteOverlay`（Enter）。

## keybindings-shell#7 — Normal exit prepares Agent history before destructive shutdown  ·  [Decision]

**Decision:** Window close, Quit and update installation share a main-owned exit gate. Native close/quit
is synchronously prevented until renderer history preparation succeeds. Main coalesces repeated exit
requests and correlates acknowledgements by current webContents plus request id. A save failure offers
Retry or Cancel exit, defaulting to cancellation. Renderer non-response after 10 seconds additionally
offers explicit Exit anyway with an unsaved-content warning; timeout never implies success.

**Reason:** Renderer owns IndexedDB and its throttled dirty snapshots. Closing the window first destroys
the only process that can flush them. Waiting only for existing writes misses both unstarted batches and
streaming chunks. Stopping/destroying Views before persistence makes Cancel unable to preserve their
operation; waiting for the model to finish can hang on long tasks or permission prompts.

**Do not change casually because:** Preparation snapshots received content without marking live runtime
complete or stopping the provider. Partial replies/thinking carry persisted interruption metadata; this is
not task completion or automatic task/queue recovery. Failed dirty batches survive UI trimming for retry.
Cancelled/timed-out attempts cannot acknowledge a later request. Exit I/O is serialized with retries and
tracked by teardown so concurrent collection cannot resurrect deleted history. Only a successful prepare
or the explicit unresponsive-renderer escape hatch permits shutdown. OS kills/crashes and unrelated
editor drafts are outside the guarantee; never describe this as saving all app data.

### Gotchas

- During prepare, a renderer overlay and keybinding guard block new local edits; cancellation releases
  them without removing tabs. Main's reload shortcut is also blocked while exit preparation is pending.
- `quitAndInstall` must run inside the approved commit callback, not before the gate or merely after an
  install-confirmation dialog. Shutdown is idempotent because lifecycle events can converge.

## keybindings-shell#8 — Connect-prompt autofocus must preserve overlay focus  ·  [Decision]

**Decision:** A disconnected Project's connect prompt uses a stable callback ref and a Project
identity key. Autofocus runs on prompt mount/Project switch or when a blocking overlay closes;
Quick Note, Settings, Command Picker, Project Edit and exit preparation suppress it while open.
Unrelated store updates must preserve the current input focus and draft.

**Reason:** An inline callback ref is replaced on each App render. React reattaches it, so an
unconditional `.focus()` steals focus from Quick Note after sidebar or background state updates.
Quick Note focuses only when opened and cannot repair this later focus loss. Keeping callback
identity tied only to the blocked state preserves Enter-to-connect after an overlay closes.

**Do not change casually because:** A mount-only callback without overlay transitions loses
keyboard focus restoration; repeatedly refocusing Quick Note leaves competing focus owners.
Notes E2E covers sidebar updates, disconnected Project switches with an open draft, and
Enter-to-connect after closing the overlay.
