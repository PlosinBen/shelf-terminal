# PROJECT_MAP — Intent → File Index

## Main Process (src/main/)

| Intent | File | Description |
|--------|------|-------------|
| App lifecycle, IPC registration | `index.ts` | BrowserWindow 建立、所有 IPC handler 註冊、app quit cleanup |
| PTY spawn/kill/resize | `pty-manager.ts` | node-pty 管理、local/SSH/WSL/Docker spawn 方式、idle notification、首次 spawn per project 觸發背景上傳清理 |
| Preload bridge | `preload.ts` | contextBridge 暴露 `window.shelfApi`，含 connector 抽象層 |
| Project 持久化 | `project-store.ts` | 讀寫 `projects.json`（userData 路徑） |
| Settings 持久化 | `settings-store.ts` | 讀寫 `settings.json`，merge defaults |
| 本機目錄列表 | `folder-list.ts` | `listDirectory()` + `getHomePath()`，支援 `~` 展開 |
| SSH 遠端目錄列表 | `ssh-manager.ts` | `sshListDir()` + `sshGetHomePath()`，透過 SSH exec |
| WSL 目錄列表 | `wsl-manager.ts` | `wslListDir()` + `wslHomePath()`，透過 `wsl.exe` |
| Docker 容器目錄列表 | `docker-manager.ts` | `dockerListDir()` / `dockerHomePath()` / `dockerListContainers()` |
| SSH ControlMaster 管理 | `ssh-control.ts` | socket 路徑產生、app quit 時清理 |
| 連線管理抽象層 | `connection-manager.ts` | `isConnected()` / `connect()` / `cleanup()`，統一 local/SSH/WSL/Docker |
| 檔案上傳 + 清理（paste / drag-drop）| `file-transfer.ts` | `uploadFile()` 寫到 `<cwd>/.tmp/shelf/`（cat-via-stdin，順手 mkdir 與 `.tmp/.gitignore`）；`cleanupSession()` / `clearUploads()` / `maybeScheduleCleanup()` 處理 session-based 與手動清理；`parseUploadPrefix()` 從檔名解出 ms timestamp 做 cutoff |
| 自動更新 wiring | `updater.ts` | electron-updater event 接線、download/install 兩段確認 |
| 自動更新 state machine | `updater-state.ts` | 純 reducer（idle/available/downloading/downloaded），由 vitest 單元測試 |
| App 啟動 / config 載入 | `bootstrap.ts` | 預先載入 projects/settings，遇錯顯示 blocking dialog |

## Renderer (src/renderer/)

| Intent | File | Description |
|--------|------|-------------|
| Root 元件 / Event handler 中樞 | `App.tsx` | 載入 projects/settings、集中處理所有 event bus 事件、split view 渲染 |
| 全域狀態管理 | `store.ts` | `useSyncExternalStore` pattern，管理 projects/tabs/settings/UI state |
| Event bus | `events.ts` | 簡單 pub/sub，定義所有 event name（CLOSE_TAB, NEW_TAB 等） |
| 快捷鍵系統 | `hooks/useKeybindings.ts` | combo string 對應 action，支援參數化 action（`switchTab_N`） |
| Terminal 渲染 | `components/TerminalView.tsx` | xterm.js instance cache、PTY I/O、檔案 paste/drag-drop 上傳、unread badge |
| Sidebar | `components/Sidebar.tsx` | Project 列表、拖曳排序、右鍵選單、收合按鈕 |
| Tab bar | `components/TabBar.tsx` | Tab 列表、拖曳排序、雙擊重命名、unread badge |
| 資料夾選擇器 | `components/FolderPicker.tsx` | 兩步驟（connection type → browse），用 connector API |
| 資料夾瀏覽器 | `components/FolderBrowser.tsx` | 純展示元件，顯示目錄清單和 keyboard hints |
| Terminal 搜尋 | `components/SearchBar.tsx` | xterm SearchAddon 整合，Enter/Shift+Enter 搜尋 |
| Settings 面板 | `components/SettingsPanel.tsx` | Theme/font/scrollback/keybinding 設定 + 錄製模式 |
| Project 編輯面板 | `components/ProjectEditPanel.tsx` | 改名、init script、default tabs 編輯（拖曳排序）、Clear uploaded files 按鈕（remote 未連線時 disabled） |
| 主題定義 | `themes.ts` | 5 個內建主題（terminal + UI 色彩） |
| Window API 型別 | `env.d.ts` | `window.shelfApi` TypeScript 宣告 |
| React entry | `main.tsx` | `createRoot` + `<App />` |

## Shared (src/shared/)

| Intent | File | Description |
|--------|------|-------------|
| Type 定義 | `types.ts` | Connection, ProjectConfig, AppSettings, IPC payloads, KeybindingAction |
| IPC channel 常數 | `ipc-channels.ts` | 所有 IPC channel name，避免 string typo |
| Logger | `logger.ts` | 統一 log 模組，支援 file writer、log level、env override |
| 預設值 | `defaults.ts` | DEFAULT_SETTINGS, DEFAULT_KEYBINDINGS |

## Config / CI

| Intent | File | Description |
|--------|------|-------------|
| Build 設定 | `vite.config.ts` | Vite + electron plugin、manualChunks 拆包、node-pty external |
| 單元測試設定 | `vitest.config.ts` | 獨立 vitest config（不繼承 vite.config.ts，避免載入 electron plugin） |
| 套件 / 打包設定 | `package.json` | electron-builder config、scripts、dependencies |
| CI/CD | `.github/workflows/build.yml` | Tag push → 三平台 build → GitHub Release |
| E2E 測試 | `e2e/helpers.ts` | Playwright fixture、userData 隔離 |
| E2E 測試 | `e2e/app-startup.spec.ts` | App 啟動、sidebar 驗證 |
| E2E 測試 | `e2e/project-creation.spec.ts` | 建立 project、connect、tab、terminal output |
| E2E 測試 | `e2e/features.spec.ts` | Search、settings、project edit 面板 |
| E2E 測試 | `e2e/init-script.spec.ts` | Init script 不重複顯示 |
| Connector 測試 | `connector/ssh.spec.ts` | SSH connect/multiplex/file upload + clearUploads（需 docker test container） |
| Connector 測試 | `connector/docker.spec.ts` | Docker exec spawn / file upload / clearUploads（需 docker test container） |
| 單元測試 | `src/main/updater-state.test.ts` | Updater reducer 21 個 transition 測試 |
| 單元測試 | `src/main/file-transfer.test.ts` | 純函式（filename / prefix / quote）+ local fs 行為（cleanupSession / clearUploads / maybeScheduleCleanup / .gitignore 自動寫入） |
