---
type: map
title: shelf-terminal — Intent → File Index
---

# Intent → File Index

每列 = 「想做什麼 → 哪個檔 → 這個模組是什麼」。資料流 / 簽名 / 為什麼這樣設計請查 architecture/ contracts/ context/。

## Main Process (src/main/)

| Intent | File | Role |
|--------|------|------|
| App lifecycle, IPC wiring | `index.ts` | app/window 啟動、`registerAllIpcHandlers()` 一次註冊、PM/Agent/updater 接線與 quit cleanup 的中樞 |
| 共享 app 狀態 | `app-state.ts` | `mainWindow` / `cachedProjects` / `cachedSettings` 的 getter/setter，index 與 ipc 共用單一來源 |
| IPC handler（按領域分檔） | `ipc/` (`index.ts` + `pty`/`project`/`connector`/`git`/`file-transfer`/`dialog`/`settings`/`logs`/`web`/`notes`/`skills`/`mcp`/`config-backup`/`updater`/`pm`) | 各檔 export `registerXxxHandlers()`，`ipc/index.ts` 匯總註冊 |
| App 層 Agent Skills（CRUD + lock） | `skills-store.ts` | `<userData>/skills/` 下 app 層 skill 的檔案 CRUD + frontmatter 驗證 + lock marker |
| Skills 變更後處理（統一 pipeline） | `skills-sync.ts` | `onSkillsChanged()`：任何 skill mutation 後的單一出口（re-project + subscribers + 通知 renderer） |
| App-tool bridge（main 端 dispatcher） | `agent/app-tool.ts` | `handleAppTool(op,args)` 把 agent-server 的 `app_tool` 請求轉成 client-owned 資源動作的純 dispatcher |
| Skills 投影（local + hash） | `skills-projection.ts` | `projectSkillsLocal` mirror skills 到 `~/.shelf/apps/<appId>/skills` + hash helper |
| App 層 MCP config store | `mcp-store.ts` | `<userData>/mcp-servers.json`（keyed object）的同步 CRUD + 驗證（web-grants 風格，opaque 不碰 secret） |
| MCP 變更後處理（sibling pipeline） | `mcp-sync.ts` | `onMcpChanged()`：re-project + subscribers + `MCP_CHANGED`；**不**呼叫 `onSkillsChanged()` |
| Config 備份/複製（App-Level Config Backup & Copy） | `config-backup/` (`binding-store`/`side-car`/`preflight`/`enumerate`/`backup`/`bind`/`import`) | backup+copy 非 sync；`side-car` 是 `simple-git` transport（clone/fetch/commit/push/diff）；`backup.ts` 快照 live→my branch；`import.ts` list sources / plan vs live / apply into live。見 `context/config-backup` |
| MCP 投影（local + hash） | `mcp-projection.ts` | `projectMcpLocal` 寫單一 `mcp-servers.json` 到 `~/.shelf/apps/<appId>/` + touch heartbeat + `hashMcpConfig` |
| MCP 遠端同步 | `mcp-remote.ts` | `syncMcpForConnection`：client-side hash-gate + transport 放到 worker（local no-op） |
| App-instance id | `app-instance-id.ts` | `getAppInstanceId()`：`<userData>/app-instance-id` 的 generate-once 穩定 UUID |
| 自訂 application menu (wiring) | `app-menu.ts` | `buildAppMenu()` 串 electron `Menu.buildFromTemplate`（mac only） |
| Application menu template | `app-menu-template.ts` | 純函式回傳 `MenuItemConstructorOptions[]` 的選單資料 |
| 選單安裝平台判斷 | `menu-platform.ts` | `shouldInstallAppMenu(platform)`（只有 darwin true） |
| Reload key predicate | `reload-guard.ts` | `isReloadKeyEvent(input)` 判斷是不是 Cmd/Ctrl+R / F5 |
| DevTools key predicate | `devtools-guard.ts` | `isDevToolsKeyEvent(input)`（F12 / Ctrl+Shift+I）的純判斷 |
| PTY spawn/kill/resize | `pty-manager.ts` | 透過 connector spawn shell、idle notification、輸出經注入的 `PtyObserver` 回報 |
| Preload bridge | `preload.ts` | contextBridge 暴露 `window.shelfApi`，純 RPC bridge 到 main |
| Project 持久化 | `project-store.ts` | 讀寫 `projects.json`（userData 路徑） |
| 專案 env 解析（plain+secret 合併） | `project-env.ts` | `resolveProjectEnv(projectId)`：合併 plain（projectConfig）+ 解密 secret 成單一注入 EnvMap，兩個 spawn 面共用的唯一出口 |
| Secret 值加密核心（純） | `secret-crypto.ts` | AES-256-GCM `encryptWithKey`/`decryptWithKey`，versioned+authenticated blob，無 electron、可測 |
| Secret master-key seam + 加密 store | `secret-store.ts` | key-storage tier（os-backed/local-key/永不明碼）依 runtime backend 選；單一 project-keyed 加密 side-car 的 CRUD + decrypt-scope-by-project |
| Settings 持久化 | `settings-store.ts` | 讀寫 `settings.json`，merge defaults |
| SSH ControlMaster 管理 | `ssh-control.ts` | socket 路徑產生、app quit 時清理 |
| SSH 伺服器列表 | `ssh-server-store.ts` | 儲存已知 SSH server 列表 |
| 檔案上傳 + 清理（paste / drag-drop） | `file-transfer.ts` | 上傳到 `<cwd>/.tmp/shelf/` + session 清理 + 檔名 prefix 解析 |
| 自動更新 wiring | `updater.ts` | electron-updater event 接線、download/install 兩段確認 |
| 自動更新 state machine | `updater-state.ts` | 純 reducer（idle/available/downloading/downloaded） |
| App 啟動 / config 載入 | `bootstrap.ts` | 預先載入 projects/settings，遇錯顯示 blocking dialog |
| userData 路徑隔離 | `user-data-path.ts` | `applyUserDataIsolation()`，依 packaged / switch 加 `-dev` 後綴 |
| Per-project storage 共用層 | `project-storage.ts` | `projectDir`/`ensureProjectDir`/`removeProjectStorage` — per-project 檔案統一在 `<userData>/projects/<id>/` |
| 啟動 migration | `migrations/migrate-pm-notes.ts` | 啟動時 idempotent 把舊 `pm-notes/<id>.md` 搬到 `projects/<id>/pm-note.md` |
| Notes 檔案存取 | `notes-store.ts` | Per-project 多筆 note CRUD + frontmatter + 圖片存檔/GC |
| Notes 圖片自訂 protocol | `notes-protocol.ts` | 註冊 `shelf-image://` scheme 給 renderer 載 note 圖片 |
| Web session（cookie jar + agent web.fetch） | `web-session.ts` | `getWebSession()`（`persist:web` 單例）+ `webFetch()`（騎 cookie 回原始回應）+ `listSessions`/`deleteSession` |
| Web session 純 helper | `web-session-helpers.ts` | `parseHttpOrigin()`：`new URL()` 防偽解析 origin + tldts 取 registrable domain（grant key / 提示顯示） |
| Web.fetch grant 持久化 | `web-grants.ts` | per-`(projectId, origin)` grant CRUD（`projects/<id>/web-grants.json`）+ `listAllGrants` |
| Web.fetch permission channel | `web-permission.ts` | `requestWebPermission()`：app 層全域 popup + away→Telegram + first-wins + timeout backstop |
| browser_open gate + 開分頁 | `browser-open.ts` | `requestBrowserOpen()`：Open/Deny popup（不記住、無 Telegram、timeout backstop）+ `openWebTab()` 送 `web:open-tab`（agent 開登入分頁的 `web.open` op 用） |
| Webview hardening | `web-session-harden.ts` | 強制安全 webPreferences、彈窗/導航/權限/下載鎖定（全在 main） |

## Connector (src/main/connector/)

| Intent | File | Role |
|--------|------|------|
| Factory + 匯出 | `index.ts` | `createConnector(connection)` factory + type 列舉 + cleanup |
| 介面定義 | `types.ts` | `Connector`（含 `putFile`）/ `Shell` / `Disposable` / `ExecResult` 介面 |
| 型別宣告傳輸 | `transport.ts` | `transportPut`（單檔，source = localPath/buffer）+ `transportPutDir`（多檔樹，解析 home 一次）→ `shelfPlacement` → worker `homePath()` → `connector.putFile`（見 `architecture/transport`） |
| PTY wrapper | `wrap-pty.ts` | 將 node-pty 包成 `Shell` 介面 |
| Shell 環境解析 | `shell-env.ts` | macOS/Linux GUI app 的 login shell env 修正 |
| 檔案操作工具 | `file-utils.ts` | 跨 connector 共用的清理/目錄操作 + `buildRemotePutCmd`（generic placement）+ `remoteUploadFile`/`buildGitignoreGuardCmd`（upload 疊在 `putFile` 上）|
| Local (Unix) | `local/unix.ts` | macOS/Linux 本機 connector |
| Local (Win32) | `local/win32.ts` | Windows 本機 connector |
| SSH (Unix) | `ssh/unix.ts` | macOS/Linux SSH connector（ControlMaster） |
| SSH (Win32) | `ssh/win32.ts` | Windows SSH connector |
| WSL | `wsl.ts` | Windows WSL connector |
| Docker | `docker.ts` | Docker exec connector |
| 單元測試 | `connector.test.ts` | available() / buildSpawnConfig() 等測試 |

## Agent View (src/main/agent/)

| Intent | File | Role |
|--------|------|------|
| Session manager + IPC handlers | `index.ts` | `initAgentManager()`：註冊 agent IPC、管理 tab→session、permission bridging |
| Remote backend | `remote.ts` | `createRemoteBackend()`：JSON line protocol 跟 agent-server 通訊 + 自帶 node/provider 部署；`syncSkillsToRemote` 走 transport `transportPutDir`（ssh tilde gotcha 見 `context/connector` connector#6）；bundle deploy 仍走 `RemoteOps.copyIn`。`USE_DISPATCHER`（`SHELF_USE_DISPATCHER!=='0'`，**預設 ON**）分支走 `ensureDispatcher()`（per-host 共用 dispatcher，`dispatcherKeyFor` 為 key、ref-counted + idle-teardown grace）；`=0` 退回 per-tab `spawnAgentServer`/`wrapProcess`（**暫時 fallback，cleanup 待移除**） |
| 主機 dispatcher 連線（main 端） | `dispatcher-connection.ts` | `createDispatcherConnection()`：一台 host 一個 dispatcher process 的 main 端擁有者。依 `sid` demux dispatcher stdout 到 per-sid `SessionChannel`（`RemoteProcess` drop-in）、單一 per-host heartbeat/health、`session_down`→`failAllTurns` fail-loud、`onDown` 驱逐、app_tool reply 路由 |
| Turn dispatcher | `turn-dispatcher.ts` | 純邏輯 event router，按 turnId 路由 wire events 到對應 turn 的 generator；`failAllTurns()` 在 session 掛掉時讓所有 in-flight turn fail-loud（error→idle） |
| Type 定義 | `types.ts` | `AgentBackend` / `AgentEvent` / `AgentSessionState` 等系統型別 |
| 連線健康（heartbeat RTT） | `connection-health.ts` | `ConnectionHealthTracker` 純狀態機：心跳 RTT → healthy/slow/unstable/dead |
| 單元測試 | `connection-health.test.ts` | RTT/狀態機 7 case |
| 單元測試 | `remote.test.ts` | Remote backend 介面、lifecycle 測試 |
| Dispatcher 單元測試 | `turn-dispatcher.test.ts` | turnId 路由 / unknown drop / lifecycle / permission isolation / `failAllTurns` |
| Dispatcher-connection 測試 | `dispatcher-connection.test.ts` | sid demux / 一台 host 一 heartbeat / session_down fail-loud / onDown 驱逐 / openSession 健康 seed + already-open replace |

## Agent Server (agent-server/)

| Intent | File | Role |
|--------|------|------|
| Role-split entry point | `index.ts` | 薄 entrypoint：讀 `--role`，dynamic-import `./exec`（預設）或 `./dispatcher`。lazy import → dispatcher role 永不載入 provider/SDK（保持 thin） |
| Execution proc（per session） | `exec.ts` | 原 agent-server 主體：stdin/stdout JSON line protocol + dispatch to Claude/Copilot + context persistence。在 dispatcher 下以 `--sid` spawn，outbound 全蓋自己的 `sid`；含 model-cache client（cache_get/put 側通道） |
| 主機 dispatcher（per host broker） | `dispatcher.ts` | 薄 per-host broker：`sid` 路由/relay（串流 opaque pass-through，只 peek pong/cache_）、open/close_session、兩層 health 的 inner-ping、supervisor（exec 死→reconnect + backoff）、per-host model cache 側通道。**不 import provider/SDK** |
| Model/caps cache（泛型 TTL） | `model-cache.ts` | `createModelCache({ttlMs})`：泛型 TTL 儲存，過期即 evict（cache-aside 的被動 store，見 `context/agent-config-flow`） |
| Session hosting 抽象（兩張 map） | `session-registry.ts` | `createSessionRegistry()`：`sessions: Map<sid, runtimeKey>` + `runtimes: Map<runtimeKey, T>`，`runtimeKeyFor` 決定 isolated（sid）/shared（provider:account）。為 shared 部署預備（isolated milestone 未用） |
| Claude provider | `providers/claude/index.ts` | `@anthropic-ai/claude-agent-sdk` wrapper：持久 streaming-input session、emit 渲染原語、auth 偵測 |
| Copilot provider | `providers/copilot/index.ts` | `@github/copilot-sdk` wrapper：spawn bundled CLI、emit 渲染原語、auth 偵測、elicitation handler |
| Provider 純 helper（claude） | `providers/claude/helpers.ts` | claude/index 抽出的 side-effect-free 函式 + types（封閉邊界，只被 claude/ 引用） |
| Turn 路由（claude） | `providers/claude/turn-router.ts` | 純 attribution 狀態機，按順序把 message 分 foreground/server/task lane |
| Provider 純 helper（copilot） | `providers/copilot/helpers.ts` | copilot/index 抽出的純函式 + types（只被 copilot/ 引用） |
| Copilot 互動登入（device flow） | `providers/copilot/login.ts` | `parseLoginPrompt`（stdout 抽 URL+code 純函式）+ `startLogin`（spawn `copilot login`、env 剝 token、cancel）+ `prefillLoginUrl`（見 `context/agent-providers` #10） |
| Provider 共用 helper | `providers/shared.ts` | `stripCwd` / `resolveSkillsPluginRoot` — 跨 provider 共用純函式 |
| MCP config 消費（解析 + ${VAR}） | `providers/mcp-config.ts` | `loadProjectedMcpServers`：讀 projected `mcp-servers.json` → 驗證 → 對 worker env 展開 `${VAR}` → fail-loud（兩 provider 共用） |
| App-tool bridge（agent-server 端） | `app-tool-client.ts` + `app-tool-tools.ts` | in-process MCP 工具的共用 body：`callMain` + `runBridgeTool` + 描述常數 |
| Log proxy → main | `server-logger.ts` | `serverLog(level,tag,msg,...args)`：args 源頭 flatten 後走 wire `log` 訊息回 main（agent-server 無獨立 observability，見 `contracts/agent-wire-protocol`） |
| ~/.shelf 清理（heartbeat-lease） | `cleanup.ts` | `runCleanupSweep()` 啟動時按 `.heartbeat` lease 回收 version/appId 殘留 |
| 正常關閉單一路徑（reap→dispose→exit） | `shutdown.ts` | `performShutdown()`：由 `rl.on('close')` 與 idle watchdog 共用，先收屍再 dispose 再 exit（見 `context/connection-health` #5） |
| Detached 任務集中收屍 | `reaper.ts` | `reapDetachedTasks()`：enumerate `listReapableTasks()` → 對 running shell 任務呼 `stopTask()`，resilient + 不放 provider dispose |
| Crash-net：Linux `/proc` 原語 | `proc-scan.ts` | 讀 `/proc/<pid>/environ`（env-tag 找孤兒）+ `/proc/<pid>/stat` start-time（owner 生死）+ group-kill；非 Linux no-op（見 `context/connection-health` #6） |
| Crash-net：session lease + 啟動 sweep | `session-sweep.ts` | `SHELF_SESSION` lease 讀寫 + `sweepDeadSessions()`：對 owner 已死的 lease 用 tag 找活著的孤兒 → group-kill |
| Copilot detached 任務 pid-kill | `providers/copilot/pid-kill.ts` | Copilot 無 stop-task RPC → 讀 detached bash 寫的 `.pid` 檔 group-kill（`stopTask` 用） |
| Context persistence | `context-store.ts` | `loadContext`/`saveContext`/`deleteContext`/`cleanupOldContexts`，atomic write 到 `~/.shelf/agent-context/` |
| Context persistence 測試 | `context-store.test.ts` | round-trip + Claude resume / Copilot chain |
| Provider types | `providers/types.ts` | `ServerBackend` / `SendFn` / `QueryInput` / `OutgoingMessage` / `ProviderCapabilities` 等 |
| Slash prefix detection | `src/shared/slash-prefix.ts` | `parseSlashPrefix(prompt)` 共用 helper（provider + renderer 同份） |
| Fake provider | `providers/fake/index.ts` | E2E-only backend，`SHELF_TEST_MODE=1` 時回它，prompt 走 prefix-matched scenario |
| Fake provider 測試 | `providers/fake/fake.test.ts` | 每個 scenario 的 wire-shape 驗證 + stop/abort 行為 |
| Bundle build | `build.mjs` | esbuild → `dist/agent-server/<version>/index.js` 單一 ESM bundle（index/exec/dispatcher 同一 bundle，role 由 argv 選） |
| 單元測試 | `providers/copilot/slash-commands.test.ts` | slash dispatch + streaming/idle status pair 測試 |
| Dispatcher 單元測試 | `dispatcher.test.ts` | open/close_session / raw relay / reconnect + backoff / inner-ping hung / proc-identity guard / cache 側通道 |
| Model-cache 單元測試 | `model-cache.test.ts` | TTL hit/miss/expiry evict |
| Session-registry 單元測試 | `session-registry.test.ts` | open/get/close + runtimeKey 共享/隔離 |

## PM Agent (src/main/pm/)

| Intent | File | Role |
|--------|------|------|
| Barrel export | `index.ts` | 統一匯出 PM 模組所有公開 API |
| LLM 對話循環 | `agent-loop.ts` | 結構化 system prompt + tool use loop + streaming + sliding window + auto-retry |
| Sliding window helper | `history-window.ts` | `trimHistoryForLLM` 切到 user boundary，避免裸切 function_call |
| LLM streaming client | `llm-client.ts` | OpenAI-compatible SSE streaming（Electron `net.fetch`），解析 tool_calls |
| Tool 定義 + 執行 | `tools.ts` | tool schemas + `executeTool` dispatcher + `inferTabState` + Away Mode 過濾 |
| Scrollback ring buffer | `scrollback-buffer.ts` | Per-tab 100KB ring buffer、ANSI strip、lastNLines 讀取 |
| Note 儲存 | `note-store.ts` | PM 單筆 note + global note 讀寫 |
| 對話持久化 | `history-store.ts` | `pm-history.json` 讀寫、boot 載入、每 turn 存檔 |
| Away Mode 狀態 | `away-mode.ts` | 全域 boolean + 同步到 renderer |
| PM Active 狀態 | `pm-active.ts` | telegram listener master 開關的純 state holder + renderer 同步 |
| 硬紅線檢查 | `redline.ts` | scrollback pattern match（rm -rf、git push --force、DROP TABLE 等） |
| Tab 狀態監控 | `tab-watcher.ts` | scrollback 狀態轉換偵測，觸發 PM 自動事件 + `snapshotTabs()` |
| PTY → PM bridge | `pty-bridge.ts` | pty-manager `PtyObserver` 的注入目標（scrollback append + tab-watcher） |
| PTY bridge 單元測試 | `pty-bridge.test.ts` | 三種訊號路由 + append-before-checkTab 順序契約 |
| Telegram bridge | `telegram.ts` | Bot API long polling、inline button、slash commands，由 PM Active 驅動 start/stop |
| 單元測試 | `scrollback-buffer.test.ts` | Ring buffer + ANSI strip 測試 |
| 單元測試 | `tools.test.ts` | inferTabState heuristic 測試 |
| 單元測試 | `redline.test.ts` | 硬紅線 pattern match 測試 |

## Renderer (src/renderer/)

| Intent | File | Role |
|--------|------|------|
| Root 元件 / Event handler 中樞 | `App.tsx` | 載入 projects/settings、集中處理所有 event bus 事件、split view 渲染的唯一 side-effect hub |
| 全域狀態管理 | `store.ts` | `useSyncExternalStore` store，管 projects/tabs/settings/UI state + connectionHealth + skillsVisible |
| Event bus | `events/` (`bus.ts` / `types.ts` / `ipc-agent.ts` / `index.ts`) | pub/sub + 類型化 `agent:*` vocabulary + IPC↔bus 適配層 |
| 快捷鍵系統 | `hooks/useKeybindings.ts` | combo string 對應 action，支援參數化 action |
| Paste/drop 上傳 hook | `hooks/useAttachmentPaste.ts` | paste/drop/upload pipeline + file size check |
| Terminal 渲染 | `components/TerminalView.tsx` | xterm.js instance cache + PTY I/O + paste hook + unread badge |
| Agent 對話 UI | `components/AgentView.tsx` + `components/agent/{MessageList,InputZone,StatusBar,DecisionPanel,PlanPanel,AuthPane,ConnectionOverlay}.tsx` + `agentTabStore.ts` + `agentTabSubscriptions.ts` + `agent-message-builder.ts` | AgentView 是 layout coordinator，domain state 在 per-tab `agentTabStore`，子 component 各自 subscribe。`ConnectionOverlay` 是 pane-scoped（`absolute` 非 `fixed`）dim+blur「未 ready」遮罩，統一 init-`starting`（first-open/reconnect，phase 文字由 `agent/init-phase.ts` 提供）/ init-`failed`（Retry）/ health-`dead`（Reconnect）四態 |
| Web tab（登入 surface + 瀏覽） | `components/WebTabView.tsx` | `<webview partition=persist:web>` + 網址列 + identity chip；人在這登入內網服務 |
| Web.fetch 授權 popup | `components/WebPermissionPrompt.tsx` | app 層全域 popup，防偽 origin 顯示 + allow once/always/deny（由 `web:permission-request` 驅動） |
| browser_open 確認 popup | `components/BrowserOpenPrompt.tsx` | app 層全域 popup，只有 Open/Deny（不記住），由 `web:browser-open-request` 驅動；核可後 `web:open-tab` 由 `App.tsx` 開分頁 |
| Web session/grant 管理 | `components/settings/WebSettingsTab.tsx` | Settings → Web 分頁：已登入 session 清單(刪) + grant whitelist(per-project 分組、revoke) |
| Config 備份/複製 UI | `components/settings/BackupSettingsTab.tsx` + `ImportSection.tsx` | Settings → Backup 分頁：未綁 remote 顯示綁定表單；綁了則 Back up \| Import 切換。Backup=per-item checklist（預勾已備份項）；Import=選來源分支→勾項目→review diff（replace/keep）→apply，含 replace-all bulk |
| App 層 MCP server 管理 | `components/McpView.tsx` | 右側欄 view（BottomBar 插頭 icon 開、Skills 的姊妹）：list + per-transport 新增/編輯(stdio/http)、rename、`?` scope help。沿用 `.right-panel` 殼 |
| 選擇面板 | `components/SelectionPanel.tsx` | Bottom-anchored 單題 N-way 選單，permission popup + config picker 共用 |
| Picker 面板 | `components/PickerPanel.tsx` | Bottom-anchored 多題互動 form（AskUserQuestion / elicitation 共用） |
| Bottom bar（全寬 app footer） | `components/BottomBar.tsx` | App 層全寬狀態列：service type/cwd + 右側分三組（分隔線）：version｜左側欄(Projects)｜右側欄(PM/Notes/Skills/MCP/DevTools) toggle |
| Sidebar | `components/Sidebar.tsx` | Project 列表、拖曳排序、右鍵選單、worktree branch、連線健康 status-dot |
| Tab bar | `components/TabBar.tsx` | Tab 列表、拖曳排序、雙擊重命名、unread badge、PM Active badge |
| 快速指令選擇器 | `components/CommandPicker.tsx` | ⌘P overlay，過濾 + 執行 per-project 快速指令 |
| 開發工具面板 | `components/DevToolsPanel.tsx` | ⌘D 右側 panel，Base64/JSON/URL/UUID/Timestamp/Hash 工具 |
| 資料夾選擇器 | `components/FolderPicker.tsx` | 兩步驟（connection type → browse）選資料夾 |
| 資料夾瀏覽器 | `components/FolderBrowser.tsx` | 純展示元件，顯示目錄清單和 keyboard hints |
| 頁內搜尋 | `components/SearchBar.tsx` | terminal tab 走 xterm SearchAddon；agent/web tab 走 main findInPage（`shelfApi.find`）+ 命中計數 |
| Settings 面板 | `components/SettingsPanel.tsx` | 左側 tab 分頁（Terminal / Agent / Models / PM Agent / Web / Backup / Shortcuts） |
| Worktree 建立 | `components/WorktreeDialog.tsx` | 輸入 branch name 建 git worktree，產生 sub-project |
| 刪除確認 | `components/RemoveConfirmDialog.tsx` | Remove project 確認 modal，可勾選清理 worktree files |
| PM 狀態面板（read-only） | `components/PmView.tsx` | 右側可拖拉 panel，read-only 訊息列表 + markdown，header 含 PM Active/Away/Clear toggle |
| Notes 面板 | `components/NotesView.tsx` | ⌘N 右側 panel，per-project markdown scratch pad（preview/edit、貼圖、auto-save） |
| Skills 面板 | `components/SkillsView.tsx` | 右側 panel，app 層 Agent Skills 管理（master-detail md 編輯器 + lock toggle） |
| Quick Note overlay | `components/QuickNoteOverlay.tsx` | ⌘⇧N floating textarea，送到當下 active project（支援貼圖） |
| Note 圖片縮圖 | `components/NoteImage.tsx` | 共用縮圖元件，透過 `notes.readImage` IPC 載 Blob URL |
| Clipboard / drop 解析 | `utils/parse-data-transfer.ts` | 純 parser，`DataTransfer → PastedItem[]`（paste/drop 共用） |
| 右側 sidebar toggle | `store.toggleRightSidebar(feature)` | PM/Notes/DevTools 三 panel 共用的 toggle action |
| Tooltip 快捷鍵 helper | `utils/format-keybinding.ts` | 純函式 `formatCombo` / `tooltipWithShortcut` |
| PM stream reducer | `components/pm-view-reducer.ts` | 純 reducer 管 PM streaming/streamText/streamToolCalls/error 四個 UI state |
| Project 編輯面板 | `components/ProjectEditPanel.tsx` | 改名、init script、default tabs、quick commands、Clear uploaded files |
| Agent UI 訊息持久化 | `storage/agent-history.ts` | IndexedDB 存 UI messages keyed by sessionId（append-only delta save） |
| Canonical Agent message type | `src/shared/types.ts` (`AgentMessage`) | 9-variant 渲染原語 discriminated union（inline + fold_* 卡片類） |
| Inline SVG icon | `components/icons.tsx` | 手繪原創 line icon（24x24，`currentColor`），footer toggle 用 |
| 主題定義 | `themes.ts` | 5 個內建主題（terminal + UI 色彩） |
| Window API 型別 | `env.d.ts` | `window.shelfApi` TypeScript 宣告 |
| React entry | `main.tsx` | `createRoot` + `<App />` |

## Shared (src/shared/)

| Intent | File | Role |
|--------|------|------|
| Type 定義 | `types.ts` | Connection / ProjectConfig / AppSettings / PM types / IPC payloads |
| IPC channel 常數 | `ipc-channels.ts` | 所有 IPC channel name 常數 |
| App 層 MCP 型別 + 驗證 | `mcp.ts` | `McpServerBlock`/`McpServersFile` + 純 validator(main store 與 agent-server loader 共用，不 pull electron） |
| Shelf 檔案 placement 規則 | `shelf-paths.ts` | `shelfPlacement(type,ctx)` closed allowlist + `ShelfFileType*` 常數(transport 與 agent-server 共用單一路徑規則） |
| 專案 env 純 helper | `project-env.ts` | `EnvMap`、`SHELF_RESERVED_ENV`、`isReservedEnvKey`/`validateEnvKey`、`applyEnvMap`（本機 merge、PATH-merge）、`buildEnvExportPrefix`（遠端 export 前綴）；main + renderer 共用 |
| Logger | `logger.ts` | 統一 log 模組，支援 file writer / log level / env override |
| 預設值 | `defaults.ts` | DEFAULT_SETTINGS, DEFAULT_KEYBINDINGS |
| Slash prefix parser | `slash-prefix.ts` | `parseSlashPrefix(prompt)`，provider + renderer 同份 |
| Web session 常數/型別 | `web-session.ts` | `WEB_SESSION_PARTITION`、`WEB_FETCH_TOOL`/`isWebFetchTool`、`BROWSER_OPEN_TOOL`/`isBrowserOpenTool`、`WebFetchRequest/Result`、`WebPermissionMeta`、`BrowserOpenMeta`/`BrowserOpenDecision` |
| 單元測試 | `slash-prefix.test.ts` | `parseSlashPrefix` 邊界 case 覆蓋 |

## Config / CI

| Intent | File | Role |
|--------|------|------|
| Path alias 定義 | `aliases.ts` | `@shared` alias 的單一來源，vite/vitest 共用 |
| Build 設定 | `vite.config.ts` | Vite + electron plugin、manualChunks、node-pty external |
| 單元測試設定 | `vitest.config.ts` | 獨立 vitest config（不繼承 vite.config.ts） |
| 套件 / 打包設定 | `package.json` | electron-builder config、scripts、dependencies |
| CI/CD | `.github/workflows/build.yml` | Tag push → 三平台 build → GitHub Release |

### npm scripts

| Script | 用途 |
|--------|------|
| `dev` | 開發模式（NODE_ENV=development，userData 加 `-dev` 後綴隔離） |
| `build` | Vite build + agent-server esbuild bundle，產出 `dist/` |
| `typecheck` | `tsc --noEmit` 型別檢查 |
| `test` | 跑全部測試（typecheck → unit → e2e → docker → ssh） |
| `test:unit` | vitest 單元測試 |
| `test:e2e` | Playwright E2E 測試（自動 build，NODE_ENV=test 隔離 userData） |
| `test:docker` | Docker connector E2E 測試 |
| `test:ssh` | SSH connector E2E 測試 |
| `test:wsl` | WSL connector E2E 測試（Windows-host-only；起 `wsl` project，需 wsl.exe） |
| `pack` | build + `electron-builder --dir`，產出 unpackaged app |
| `dist` | build + `electron-builder`，產出 packaged installer |
| `dist:mac` | 同 `dist`，限 macOS |
| `dist:win` | 同 `dist`，限 Windows |
| `dist:linux` | 同 `dist`，限 Linux |

### Tests

| Intent | File | Role |
|--------|------|------|
| E2E helpers | `e2e/helpers.ts` | Playwright fixture、per-worker tempdir userData 隔離、agent helper（預設 `SHELF_TEST_MODE=1`） |
| E2E 測試 | `e2e/agent-picker.spec.ts` | Picker_request 全鏈（single/multi/cancel/free-text），fake provider |
| E2E 測試 | `e2e/agent-flows.spec.ts` | permission / stream / fold 卡片 / auth_required / 互動 device-flow 登入（button→code→cancel）/ error / Esc stop，fake provider |
| E2E 測試 | `e2e/app-startup.spec.ts` | App 啟動、sidebar 驗證 |
| E2E 測試 | `e2e/project-creation.spec.ts` | 建立 project、connect、tab、terminal output |
| E2E 測試 | `e2e/features.spec.ts` | Search、settings、project edit、dev tools、快捷鍵 |
| E2E 測試 | `e2e/config-bootstrap.spec.ts` | Config 損毀 bootstrap dialog（quit / backup & continue） |
| E2E 測試 | `e2e/pm-agent.spec.ts` | PM sidebar、PmView toggle、provider settings、Away Mode、Telegram |
| E2E 測試 | `e2e/init-script.spec.ts` | Init script 不重複顯示 |
| Connector 測試 | `e2e/connector/ssh.spec.ts` | SSH connect/multiplex/file upload + clearUploads |
| Connector 測試 | `e2e/connector/docker.spec.ts` | Docker exec spawn / file upload / clearUploads |
| Connector 測試 | `e2e/connector/wsl.spec.ts` | WSL file upload + clearUploads（Windows-only `wsl` project，`test.skip` 非 win32）|
| Connector 測試 | `e2e/local-upload.spec.ts` | Local connector upload：落地 `.tmp/shelf` + non-clobber `.gitignore`（預設 `e2e` project，到處跑）|
| 單元測試 | `src/main/updater-state.test.ts` | Updater reducer 21 個 transition 測試 |
| 單元測試 | `src/main/file-transfer.test.ts` | 純函式 + local fs 行為 |
| 單元測試 | `src/main/user-data-path.test.ts` | `applyUserDataIsolation()` 五個分支 |
| 單元測試 | `src/main/project-store.test.ts` | Project store read/write/backup 測試 |
