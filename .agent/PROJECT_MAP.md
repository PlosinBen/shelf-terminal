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

### Agent (src/main/agent/)

| Intent | File | Description |
|--------|------|-------------|
| IPC + session lifecycle | `index.ts` | `ensureSession()` checkAuth → apply prefs → warmup → broadcast capabilities; handlers for INIT/SEND/STOP/DESTROY/RESOLVE_PERMISSION/SET_PREFS/SWITCH_PROVIDER; per-session allowlist for "allow (this session)" |
| Backend interface + events | `types.ts` | `AgentBackend`, `AgentEvent` union, `AgentQueryOptions`, `ProviderCapabilities`, `AgentPrefs` |
| Claude provider | `providers/claude.ts` | Wraps `@anthropic-ai/claude-agent-sdk`, warmup fetches models/commands in plan mode, forwards effort string to SDK's native `effort` option |
| Copilot provider | `providers/copilot.ts` | Thin wrapper: Copilot endpoint, session-token refresh, fetches `/models`, populates per-model effortLevels + context window map |
| Gemini provider | `providers/gemini.ts` | Placeholder — to be built on openai-processor |
| OpenAI-compatible agent loop | `providers/openai-processor.ts` | Multi-turn chat-completions loop: tool-call delta accumulation, permission gating, plan mode tool filter, slash command dispatch (`/clear/compact/context/help/model/status/tools/ask`), reasoning_effort passthrough, token + context tracking |
| Tool registry + pattern helpers | `providers/processor-tools.ts` | Read/Grep/Glob/Ls/Bash/Edit/Write schemas with categories, `toolsForMode()` filter, permission semantics, `getEffortLevels()` pattern detector, `buildSystemPrompt()`, `SLASH_COMMANDS` |
| Tool execution | `providers/tool-executor.ts` | Dispatches each tool via `connector.exec` so local/SSH/Docker/WSL work uniformly; also hosts `loadProjectInstructions(cwd)` which reads AGENTS.md/CLAUDE.md from git root |
| Copilot auth | `auth/copilot-auth.ts` | Resolves GitHub token from `~/.config/github-copilot/apps.json` → `gh auth token`; exchanges for Copilot session token (~30 min TTL, auto-refresh) |
| Remote agent stdin/stdout | `remote.ts` | Remote backend protocol — used when agent runs on SSH/Docker host |
| Agent-server deploy | `deploy.ts` | Version-isolated deployment of agent-server binary to remote |
| Unit tests | `providers/processor-tools.test.ts` | Tool registry, permission semantics, effort pattern, system prompt tests |

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

## Renderer (src/renderer/)

| Intent | File | Description |
|--------|------|-------------|
| Root 元件 / Event handler 中樞 | `App.tsx` | 載入 projects/settings、集中處理所有 event bus 事件、split view 渲染 |
| 全域狀態管理 | `store.ts` | `useSyncExternalStore` pattern，管理 projects/tabs/settings/UI state |
| Event bus | `events.ts` | 簡單 pub/sub，定義所有 event name（CLOSE_TAB, NEW_TAB, CREATE_WORKTREE 等） |
| 快捷鍵系統 | `hooks/useKeybindings.ts` | combo string 對應 action，支援參數化 action（`switchTab_N`） |
| Terminal 渲染 | `components/TerminalView.tsx` | xterm.js instance cache、PTY I/O、檔案 paste/drag-drop 上傳、unread badge |
| Agent tab view | `components/AgentView.tsx` | Provider picker、message list、status bar (mode/model/effort/ctx%/tokens)、permission overlay、model picker overlay、slash menu (arrow-key nav)、auth-required screen |
| Agent message renderer | `components/AgentMessage.tsx` | 單則訊息渲染：tool-specific display (Bash/Read/Edit diff 等)、markdown、thinking collapsed |
| Agent history | `agent-history.ts` | IndexedDB 儲存 per-project messages、30 天自動輪替 |
| Sidebar | `components/Sidebar.tsx` | Project 列表、拖曳排序、右鍵選單（含 New Worktree）、worktree branch 顯示、收合按鈕 |
| Tab bar | `components/TabBar.tsx` | Tab 列表、拖曳排序、雙擊重命名、unread badge、tab 顏色 |
| 快速指令選擇器 | `components/CommandPicker.tsx` | ⌘E 叫出 overlay，過濾 + 執行 per-project 快速指令 |
| 開發工具面板 | `components/DevToolsPanel.tsx` | ⌘D toggle 右側 panel，accordion 可收合，Base64/JSON/URL/UUID/Timestamp/Hash 工具，寬度可拖拉調整 |
| 資料夾選擇器 | `components/FolderPicker.tsx` | 兩步驟（connection type → browse），用 connector API |
| 資料夾瀏覽器 | `components/FolderBrowser.tsx` | 純展示元件，顯示目錄清單和 keyboard hints |
| Terminal 搜尋 | `components/SearchBar.tsx` | xterm SearchAddon 整合，Enter/Shift+Enter 搜尋 |
| Bottom bar | `components/BottomBar.tsx` | 顯示 connection type、cwd、git branch；branch dropdown 支援切換或跳轉 worktree project |
| Settings 面板 | `components/SettingsPanel.tsx` | Theme/font/scrollback/keybinding/unicode11 設定 + 錄製模式 |
| Worktree 建立 | `components/WorktreeDialog.tsx` | 輸入新 branch name 建立 git worktree，產生 sub-project |
| 刪除確認 | `components/RemoveConfirmDialog.tsx` | Remove project 確認 modal，worktree 可勾選是否清理 worktree files |
| Project 編輯面板 | `components/ProjectEditPanel.tsx` | 改名、init script、default tabs、quick commands 編輯、Clear uploaded files |
| 主題定義 | `themes.ts` | 5 個內建主題（terminal + UI 色彩） |
| Window API 型別 | `env.d.ts` | `window.shelfApi` TypeScript 宣告 |
| React entry | `main.tsx` | `createRoot` + `<App />` |

## Shared (src/shared/)

| Intent | File | Description |
|--------|------|-------------|
| Type 定義 | `types.ts` | Connection, ProjectConfig（含 parentProjectId/worktreeBranch）, QuickCommand, AppSettings, IPC payloads, KeybindingAction, GitBranchInfo, WorktreeAddResult |
| IPC channel 常數 | `ipc-channels.ts` | 所有 IPC channel name（含 git:branch-list/worktree-add/worktree-remove），避免 string typo |
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
| E2E 測試 | `e2e/helpers.ts` | Playwright fixture、每 worker 用 tempdir + `--user-data-dir` 隔離 userData |
| E2E 測試 | `e2e/app-startup.spec.ts` | App 啟動、sidebar 驗證 |
| E2E 測試 | `e2e/project-creation.spec.ts` | 建立 project、connect、tab、terminal output |
| E2E 測試 | `e2e/features.spec.ts` | Search、settings、project edit、dev tools、所有快捷鍵 |
| E2E 測試 | `e2e/config-bootstrap.spec.ts` | Config 損毀時 bootstrap dialog 處理（quit / backup & continue） |
| E2E 測試 | `e2e/init-script.spec.ts` | Init script 不重複顯示 |
| Connector 測試 | `e2e/connector/ssh.spec.ts` | SSH connect/multiplex/file upload + clearUploads（需 docker test container） |
| Connector 測試 | `e2e/connector/docker.spec.ts` | Docker exec spawn / file upload / clearUploads（需 docker test container） |
| 單元測試 | `src/main/updater-state.test.ts` | Updater reducer 21 個 transition 測試 |
| 單元測試 | `src/main/file-transfer.test.ts` | 純函式（filename / prefix / quote）+ local fs 行為 |
| 單元測試 | `src/main/user-data-path.test.ts` | `applyUserDataIsolation()` 五個分支（packaged / unpackaged / switch / idempotent） |
