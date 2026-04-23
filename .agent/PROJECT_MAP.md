# PROJECT_MAP — Intent → File Index

## Main Process (src/main/)

| Intent | File | Description |
|--------|------|-------------|
| App lifecycle, IPC registration | `index.ts` | BrowserWindow 建立、所有 IPC handler 註冊、app quit cleanup |
| PTY spawn/kill/resize | `pty-manager.ts` | 透過 connector.createShell() spawn、idle notification、首次 spawn per project 觸發背景上傳清理 |
| Preload bridge | `preload.ts` | contextBridge 暴露 `window.shelfApi`，RPC bridge 到 main process |
| Project 持久化 | `project-store.ts` | 讀寫 `projects.json`（userData 路徑） |
| Settings 持久化 | `settings-store.ts` | 讀寫 `settings.json`，merge defaults |
| SSH ControlMaster 管理 | `ssh-control.ts` | socket 路徑產生、app quit 時清理 |
| SSH 伺服器列表 | `ssh-server-store.ts` | 儲存已知 SSH server 列表 |
| 檔案上傳 + 清理（paste / drag-drop）| `file-transfer.ts` | `uploadFile()` 寫到 `<cwd>/.tmp/shelf/`；`cleanupSession()` / `clearUploads()` / `maybeScheduleCleanup()` 處理清理；`parseUploadPrefix()` 從檔名解出 ms timestamp |
| 自動更新 wiring | `updater.ts` | electron-updater event 接線、download/install 兩段確認 |
| 自動更新 state machine | `updater-state.ts` | 純 reducer（idle/available/downloading/downloaded），由 vitest 單元測試 |
| App 啟動 / config 載入 | `bootstrap.ts` | 預先載入 projects/settings，遇錯顯示 blocking dialog |
| userData 路徑隔離 | `user-data-path.ts` | `applyUserDataIsolation()`，靠 `app.isPackaged` + `--user-data-dir` 判斷，unpackaged 且無 switch 時加 `-dev` 後綴 |
### Connector (src/main/connector/)

| Intent | File | Description |
|--------|------|-------------|
| Factory + 匯出 | `index.ts` | `createConnector(connection)` factory、`getAvailableTypes()`、`cleanupConnectors()` |
| 介面定義 | `types.ts` | `Connector`（含 `exec()`）、`Shell`、`Disposable`、`ExecResult` 介面 |
| PTY wrapper | `wrap-pty.ts` | 將 node-pty 包成 `Shell` 介面 |
| Shell 環境解析 | `shell-env.ts` | macOS/Linux GUI app 的 login shell env 修正 |
| 檔案操作工具 | `file-utils.ts` | 跨 connector 共用的上傳/清理/目錄操作 |
| Local (Unix) | `local/unix.ts` | macOS/Linux 本機 connector |
| Local (Win32) | `local/win32.ts` | Windows 本機 connector |
| SSH (Unix) | `ssh/unix.ts` | macOS/Linux SSH connector（ControlMaster） |
| SSH (Win32) | `ssh/win32.ts` | Windows SSH connector |
| WSL | `wsl.ts` | Windows WSL connector |
| Docker | `docker.ts` | Docker exec connector |
| 單元測試 | `connector.test.ts` | available()、buildSpawnConfig() 等測試 |

### PM Agent (src/main/pm/)

| Intent | File | Description |
|--------|------|-------------|
| Barrel export | `index.ts` | 統一匯出 PM 模組所有公開 API |
| LLM 對話循環 | `agent-loop.ts` | 結構化 system prompt（角色/職責/工作流程/邊界 + 動態 Away Mode）、tool use loop、streaming、sliding window（40 turns）、auto-retry（exponential backoff）、tab event 自動注入 |
| LLM streaming client | `llm-client.ts` | OpenAI-compatible SSE streaming（用 Electron `net.fetch`），支援 tool_calls 解析 |
| Tool 定義 + 執行 | `tools.ts` | 10 tool schemas（L0 觀察 + L0.5 note + global note + write_to_pty）、`executeTool` dispatcher、`inferTabState` heuristic、Away Mode 過濾 |
| Scrollback ring buffer | `scrollback-buffer.ts` | Per-tab 100KB ring buffer、ANSI strip、lastNLines 讀取 |
| Note 儲存 | `note-store.ts` | Project notes（`<userData>/pm-notes/<projectId>.md`）+ global note（`<userData>/pm-global-note.md`）|
| 對話持久化 | `history-store.ts` | `<userData>/pm-history.json` 讀寫、app 啟動載入、每 turn 存檔 |
| Away Mode 狀態 | `away-mode.ts` | 全域 boolean + 同步到 renderer |
| 硬紅線檢查 | `redline.ts` | scrollback pattern match（rm -rf、git push --force、DROP TABLE 等） |
| Tab 狀態監控 | `tab-watcher.ts` | scrollback 狀態轉換偵測（cli_running → cli_waiting_permission 等），觸發 PM 自動事件 |
| Telegram bridge | `telegram.ts` | Bot API long polling、sendMessage、inline button（Allow/Deny、Away toggle）、callback query 處理 |
| 單元測試 | `scrollback-buffer.test.ts` | Ring buffer + ANSI strip 測試 |
| 單元測試 | `tools.test.ts` | inferTabState heuristic 測試 |
| 單元測試 | `redline.test.ts` | 硬紅線 pattern match 測試 |

## Renderer (src/renderer/)

| Intent | File | Description |
|--------|------|-------------|
| Root 元件 / Event handler 中樞 | `App.tsx` | 載入 projects/settings、集中處理所有 event bus 事件、split view 渲染 |
| 全域狀態管理 | `store.ts` | `useSyncExternalStore` pattern，管理 projects/tabs/settings/UI state |
| Event bus | `events.ts` | 簡單 pub/sub，定義所有 event name（CLOSE_TAB, NEW_TAB, CREATE_WORKTREE 等） |
| 快捷鍵系統 | `hooks/useKeybindings.ts` | combo string 對應 action，支援參數化 action（`switchTab_N`） |
| Paste/drop 上傳 hook | `hooks/useAttachmentPaste.ts` | 從 TerminalView 抽出的 paste/drop/upload pipeline，支援 file size check |
| Terminal 渲染 | `components/TerminalView.tsx` | xterm.js instance cache、PTY I/O、useAttachmentPaste hook、unread badge |
| Bottom bar | `components/BottomBar.tsx` | 顯示 connection type、cwd、git branch；branch dropdown 支援切換或跳轉 worktree project |
| Sidebar | `components/Sidebar.tsx` | Project 列表、拖曳排序、右鍵選單（含 New Worktree）、worktree branch 顯示、收合按鈕 |
| Tab bar | `components/TabBar.tsx` | Tab 列表、拖曳排序、雙擊重命名、unread badge、tab 顏色 |
| 快速指令選擇器 | `components/CommandPicker.tsx` | ⌘E 叫出 overlay，過濾 + 執行 per-project 快速指令 |
| 開發工具面板 | `components/DevToolsPanel.tsx` | ⌘D toggle 右側 panel，accordion 可收合，Base64/JSON/URL/UUID/Timestamp/Hash 工具，寬度可拖拉調整 |
| 資料夾選擇器 | `components/FolderPicker.tsx` | 兩步驟（connection type → browse），用 connector API |
| 資料夾瀏覽器 | `components/FolderBrowser.tsx` | 純展示元件，顯示目錄清單和 keyboard hints |
| Terminal 搜尋 | `components/SearchBar.tsx` | xterm SearchAddon 整合，Enter/Shift+Enter 搜尋 |
| Settings 面板 | `components/SettingsPanel.tsx` | 左側 tab 分頁（Terminal / PM Agent / Shortcuts）；PM Agent tab 含 provider config + Telegram bridge |
| Worktree 建立 | `components/WorktreeDialog.tsx` | 輸入新 branch name 建立 git worktree，產生 sub-project |
| 刪除確認 | `components/RemoveConfirmDialog.tsx` | Remove project 確認 modal，worktree 可勾選是否清理 worktree files |
| PM 聊天面板 | `components/PmView.tsx` | 右側可拖拉 panel（訊息列表 + markdown 渲染 + streaming + tool call 摺疊 + Away Mode toggle + error 顯示）|
| Project 編輯面板 | `components/ProjectEditPanel.tsx` | 改名、init script、default tabs、quick commands 編輯、Clear uploaded files |
| 主題定義 | `themes.ts` | 5 個內建主題（terminal + UI 色彩） |
| Window API 型別 | `env.d.ts` | `window.shelfApi` TypeScript 宣告 |
| React entry | `main.tsx` | `createRoot` + `<App />` |

## Shared (src/shared/)

| Intent | File | Description |
|--------|------|-------------|
| Type 定義 | `types.ts` | Connection, ProjectConfig, AppSettings（含 pmProvider/telegram）, PM types（PmMessage, PmStreamChunk, TabScanResult, PmEscalation 等）, IPC payloads |
| IPC channel 常數 | `ipc-channels.ts` | 所有 IPC channel name（含 pm:send/stream/away-mode、git:branch-list 等），避免 string typo |
| Logger | `logger.ts` | 統一 log 模組，支援 file writer、log level、env override |
| 預設值 | `defaults.ts` | DEFAULT_SETTINGS, DEFAULT_KEYBINDINGS |

## Config / CI

| Intent | File | Description |
|--------|------|-------------|
| Path alias 定義 | `aliases.ts` | `@shared` alias 的單一來源，vite/vitest config 共用 |
| Build 設定 | `vite.config.ts` | Vite + electron plugin、manualChunks 拆包、node-pty external |
| 單元測試設定 | `vitest.config.ts` | 獨立 vitest config（不繼承 vite.config.ts，避免載入 electron plugin） |
| 套件 / 打包設定 | `package.json` | electron-builder config、scripts、dependencies |
| CI/CD | `.github/workflows/build.yml` | Tag push → 三平台 build → GitHub Release |
| E2E 測試 | `e2e/helpers.ts` | Playwright fixture、每 worker 用 tempdir + `--user-data-dir` 隔離 userData、`readActiveTerminalText()` helper |
| E2E 測試 | `e2e/app-startup.spec.ts` | App 啟動、sidebar 驗證 |
| E2E 測試 | `e2e/project-creation.spec.ts` | 建立 project、connect、tab、terminal output |
| E2E 測試 | `e2e/features.spec.ts` | Search、settings、project edit、dev tools、所有快捷鍵 |
| E2E 測試 | `e2e/config-bootstrap.spec.ts` | Config 損毀時 bootstrap dialog 處理（quit / backup & continue） |
| E2E 測試 | `e2e/pm-agent.spec.ts` | PM sidebar entry、PmView toggle、provider settings、Away Mode、Telegram settings |
| E2E 測試 | `e2e/init-script.spec.ts` | Init script 不重複顯示 |
| Connector 測試 | `e2e/connector/ssh.spec.ts` | SSH connect/multiplex/file upload + clearUploads（需 docker test container） |
| Connector 測試 | `e2e/connector/docker.spec.ts` | Docker exec spawn / file upload / clearUploads（需 docker test container） |
| 單元測試 | `src/main/updater-state.test.ts` | Updater reducer 21 個 transition 測試 |
| 單元測試 | `src/main/file-transfer.test.ts` | 純函式（filename / prefix / quote）+ local fs 行為 |
| 單元測試 | `src/main/user-data-path.test.ts` | `applyUserDataIsolation()` 五個分支（packaged / unpackaged / switch / idempotent） |
| 單元測試 | `src/main/project-store.test.ts` | Project store read/write/backup 測試 |
