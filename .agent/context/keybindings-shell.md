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

## keybindings-shell#4 — 外部連結必須 `target="_blank"`，否則 Electron window 會被帶走  ·  [Gotcha]

**Symptom**：在 renderer 放 `<a href="https://...">` 沒加 `target="_blank"`，點下去整個 app window 跳到那個網址，terminal state 全失。

**Root cause**：Electron 預設沒有區分內部/外部連結。`createWindow()` 裡用 `setWindowOpenHandler` 攔 `target="_blank"`/`window.open()` 呼叫 `shell.openExternal` 丟給系統瀏覽器；但 in-window navigation（plain link click）不會經過 handler。

**Rule**：
- renderer 所有 `<a href="http(s)://...">` 一律加 `target="_blank" rel="noopener noreferrer"`。
- 不要在 renderer 用 `window.location = url` 跳外部網址。
- 需要程式化開外部連結時，走 IPC → main process → `shell.openExternal`（目前還沒有這個 channel，需要時再加）。

**Do not change casually because**：不要拿掉 `setWindowOpenHandler` 的 scheme 白名單（只放 http/https/mailto），避免 `javascript:` / `file:` 被誤丟 `shell.openExternal`。

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
