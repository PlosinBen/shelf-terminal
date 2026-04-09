# DECISIONS — Architecture Decision Records

## 1. Event Bus 驅動 UI 動作

**決策**: 所有 user action（close tab、new tab、connect 等）透過 `events.ts` 的 pub/sub emit，副作用集中在 `App.tsx` 的 event handler 處理。

**原因**: UI 元件（TabBar、Sidebar、useKeybindings）只管觸發，不需要知道 pty kill、terminal dispose、persist 這些實作細節。避免同一個邏輯散落在多個檔案。

**不要改**: 如果把副作用分散回各元件，新增 trigger point 時就要到處複製 cleanup 邏輯。

---

## 2. Connector 抽象層

**決策**: Preload 的 `connector.listDir()` / `connector.homePath()` 根據 connection type 自動 dispatch 到對應 IPC（local / SSH / WSL）。

**原因**: FolderPicker 不需要 switch connection type，只管呼叫 connector。新增 connection type 時只改 preload，不動 UI。

**不要改**: 如果讓 renderer 直接判斷 connection type 再呼叫不同 API，每個用到目錄列表的地方都要重複 switch。

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

## 8. Settings Shallow Merge with Defaults

**決策**: `loadSettings()` 用 `{ ...DEFAULT_SETTINGS, ...saved }` merge，新增 setting key 時舊的 settings.json 自動補預設值。

**原因**: 向前相容。用戶升級版本後不需要手動加新欄位。

**不要改**: 如果直接讀 saved 不 merge，舊版 settings.json 缺少新欄位會 crash。

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

## 11. ConnectionManager 抽象層

**決策**: `connection-manager.ts` 封裝 `isConnected()` / `connect()` / `cleanup()`，統一 local/SSH/WSL 連線狀態管理。Preload 的 `connector` namespace 統一暴露 `listDir` / `homePath` / `isConnected` / `connect`。

**原因**: FolderPicker 不需要知道 ControlMaster socket 路徑、SSH establish 方式等底層細節。統一介面後新增 connection type 只改 ConnectionManager，UI 不動。

**不要改**: 如果讓 renderer 直接判斷 connection type 再呼叫不同 API，每個用到連線的地方都要重複 switch。

---

## 12. Terminal 持久渲染（不 unmount）

**決策**: 所有 project 的所有 tab 都持久渲染，用 `display: none` 隱藏非 active 的。切換 project/tab 只改 visibility。

**原因**: 如果只渲染 activeProject 的 tabs，切換 project 時 React unmount → remount → 重新 spawn pty，丟失 terminal 狀態。

**不要改**: unmount/remount 會導致 pty 重複 spawn 和 terminal 內容遺失。

---

## 13. TerminalView 是唯一 spawn 點

**決策**: 只有 `TerminalView` 的 useEffect mount 時呼叫 `pty.spawn`。Event handler（NEW_TAB、CONNECT_PROJECT）只負責 `addTab()`。

**原因**: 之前 event handler 和 TerminalView 都 spawn，導致每個 tab 被 spawn 兩次。

**不要改**: 如果在 event handler 也 spawn，會跟 TerminalView mount 重複。
