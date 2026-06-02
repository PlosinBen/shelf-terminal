# PROJECT_MAP — Intent → File Index

## Main Process (src/main/)

| Intent | File | Description |
|--------|------|-------------|
| App lifecycle, IPC wiring | `index.ts` | BrowserWindow 建立、外部連結 handler（`setWindowOpenHandler` → `shell.openExternal`）、Cmd/Ctrl+R / F5 reload 攔截 + 確認 dialog、`registerAllIpcHandlers()` 一次註冊、PM/Agent/updater wiring、app quit cleanup。**不再含 inline IPC handler**（P0-2 已拆到 `ipc/`）|
| 共享 app 狀態 | `app-state.ts` | `mainWindow` / `cachedProjects` / `cachedSettings` 的 getter/setter；index.ts 與 `ipc/*` 共用的單一來源 |
| IPC handler（按領域分檔） | `ipc/` (`index.ts` + `pty`/`project`/`connector`/`git`/`file-transfer`/`dialog`/`settings`/`logs`/`notes`/`updater`/`pm`) | 每檔 export `registerXxxHandlers()`，`ipc/index.ts` 的 `registerAllIpcHandlers()` 匯總。狀態走 `app-state` accessors。agent handler 仍由 `agent/index.ts` 的 `initAgentManager()` 獨立註冊 |
| 自訂 application menu (wiring) | `app-menu.ts` | `buildAppMenu({ onCheckForUpdates })` 串 electron `Menu.buildFromTemplate` + `shell.openExternal` / `openPath`，呼叫 `app-menu-template` 拿純資料 |
| Application menu template | `app-menu-template.ts` | 純函式 `buildAppMenuTemplate(actions, platform, appName)` 回傳 `MenuItemConstructorOptions[]`；vitest 測 25 case，含 NO `reload` / `forceReload` regression guard |
| Reload key predicate | `reload-guard.ts` | `isReloadKeyEvent(input)` 判斷 webContents `before-input-event` 是不是 Cmd/Ctrl+R / F5；vitest 測 11 case 涵蓋平台差異 |
| PTY spawn/kill/resize | `pty-manager.ts` | 透過 connector.createShell() spawn、idle notification、首次 spawn per project 觸發背景上傳清理。**不依賴 pm/**（P1-1）：輸出/lifecycle 透過注入的 `PtyObserver`（`setPtyObserver()`）回報，由 index.ts 接到 pm handler。同 `setWritePtyFn` 的注入慣例 |
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
| Per-project storage 共用層 | `project-storage.ts` | `projectDir(id)` / `ensureProjectDir(id)` / `removeProjectStorage(id)` — 所有 per-project 檔案統一在 `<userData>/projects/<id>/` 之下；移除 project 一行 `fs.rm` 整包清掉 |
| 啟動 migration | `migrations/migrate-pm-notes.ts` | 啟動時 idempotent 把舊 `pm-notes/<id>.md` → `projects/<id>/pm-note.md`（copy → verify → unlink，partial run 安全 resume）|
| Notes 檔案存取 | `notes-store.ts` | `readNote/writeNote/saveImage` + `garbageCollectImages`：每次寫入掃 `images/<uuid>` ref，未被引用的圖檔立刻刪除 |
| Notes 圖片自訂 protocol | `notes-protocol.ts` | 註冊 `shelf-image://<projectId>/<filename>` scheme 給 renderer 載入 note 圖片；segment 驗證拒絕 path traversal |

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

### Agent View (src/main/agent/)

| Intent | File | Description |
|--------|------|-------------|
| Session manager + IPC handlers | `index.ts` | `initAgentManager(windowGetter)` 註冊所有 agent IPC、管理 tab→session mapping、permission bridging、`getAgentState()` / `isAgentTab()` / `disposeAllAgents()`、傳遞 `sessionId` 到 remote backend |
| Remote backend | `remote.ts` | `createRemoteBackend()` 透過 stdin/stdout JSON line protocol 跟 agent-server 通訊；支援 local/SSH/Docker/WSL spawn；`deployAgentServer()` 自動 SCP/docker cp bundle 到遠端（WSL 走 `toWslPath` 轉換 Windows→`/mnt/` 路徑）；`clearContext()` 通知 agent-server 刪除 context 檔。每個 `query()` 生成 `turnId` 註冊到 `turn-dispatcher`，IPC `send` 帶 turnId 給 agent-server，dispatcher 按 turnId 路由 events 回 per-turn AsyncGenerator |
| Turn dispatcher | `turn-dispatcher.ts` | `createTurnDispatcher()` 純邏輯 event router，按 `turnId` envelope 路由 wire events 到對應 turn 的 AsyncGenerator；lifecycle (`ready` / requestId-keyed RPC) 走獨立 channel；未知 turnId / 過期 turn 的殘留 event 直接 drop。從 `wrapProcess` 抽出來方便單測 |
| Type 定義 | `types.ts` | `AgentBackend`（含 `clearContext?`）、`AgentEvent`（含 `AgentStreamDelta.msgId`）、`AgentSessionState` 等 agent 系統型別 |
| 單元測試 | `remote.test.ts` | Remote backend 介面、lifecycle 測試 |
| Dispatcher 單元測試 | `turn-dispatcher.test.ts` | turnId 路由 / unknown turn drop / lifecycle / permission per-turn isolation / awaitReady / requestId 一次性 handler — 9 case |

### Agent Server (agent-server/)

| Intent | File | Description |
|--------|------|-------------|
| Entry point | `index.ts` | stdin/stdout JSON line protocol server、dispatch to Claude/Copilot backends、啟動時呼叫 `cleanupOldContexts()` 清理 30 天以上的 context 檔。**Context persistence 在這裡集中**：每次 `send` 前 `loadContext()` 灌進 `QueryInput.restoreContext`、wrap send fn 攔截 provider 回的 `context_patch` 訊息合併寫入；`clear_context` IPC 同步 `deleteContext()` + 呼叫 `backend.resetSession()`；`/clear` 回 `context-cleared` 時也 `deleteContext` |
| Claude provider | `providers/claude/index.ts` | `@anthropic-ai/claude-agent-sdk` wrapper、permission bridging、auto-resume（`lastSessionId`）、stream_event delta 處理、suppress synthetic/subagent model。Emit 新渲染原語 type（DECISIONS #60）：text→`reply`、thinking→`fold_text`（tone='muted'）、tool→`fold_code`（成功 body=stdout、失敗 body+errorMessage）、Edit→`fold_diff`、Write→`fold_code`、`/compact`→`fold_markdown`。`formatClaudeToolInput()` 把 toolInput 攤平成 canonical `subtitle` 字串；`extractToolResultText()` 把 SDK 的 content-block array（Task/Agent sub-agent 標準返回格式）展開成純文字。**Plan-panel mirror**：`tasks: Map<taskId, TaskRecord>` + `pendingTaskCreates: Map<toolUseId, ...>` 封裝在 provider closure，鏡射 SDK 0.3.142+ 的 `TaskCreate/TaskUpdate/TaskGet/TaskList` 工具流（TodoWrite 已 deprecated）。`parseTaskCreateOutput / parseTaskListOutput / reconcileTasks / renderPlan` 是純 helpers；TaskCreate 等 tool_result 才能拿 taskId，TaskUpdate 樂觀立刻套用，TaskList 結果做 drift correction。對 renderer 維持 `{type:'plan', content:md}` 介面不變。詳見 `.agent/features/sdk-upgrade-0.3.md`。`/clear` eager-clear：除了 `pass-through` 給 SDK 自處理外，同步清 `lastSessionId` + 清空 `tasks` / `pendingTaskCreates` Map + 發 `context_patch: { lastSdkSessionId: null }`，避免「`/clear` 後立刻關 app」邊界 case 復活舊 session。**AskUserQuestion 攔截**：`canUseTool` 在 toolName='AskUserQuestion' 時不走 permission_request，改用 `askUserQuestionToPrompts()` 轉成 picker_request、await renderer resolve、`buildAskUserQuestionAnswerJson()` 構造 SDK output JSON 塞進 deny.message 餵回 model（SDK 0.2.126 沒 onAskUserQuestion callback，spike 驗證可行 — `scripts/spike-askuser.ts`） |
| Copilot provider | `providers/copilot/index.ts` | `@github/copilot-sdk` wrapper（spawn bundled `@github/copilot` CLI）、`gh auth token` 拿 token 傳 `gitHubToken` 跳過 keychain、permission bridging、event mapping (delta/message/tool/usage/plan)、`/context` `/compact` `/clear` `/help`（`/model` 由 renderer 攔截，見 DECISIONS #55）、reasoning effort、permission mode mapping (`default→interactive`/`bypassPermissions→autopilot`/`plan→plan`)、TodoWrite/ExitPlanMode 沒在 Copilot — 走獨立 `OutgoingMessage { type: 'plan' }` event（DECISIONS #60，不進 timeline）。Emit 渲染原語 type：report_intent→`note`、reasoning→`fold_text`、tool 成功/失敗→`fold_code`、`apply_patch` Update→`fold_diff`、`apply_patch` Add→`fold_code`、slash→`fold_markdown`。`formatCopilotToolInput()` 把 args 攤平成 canonical `subtitle` 字串；`parseApplyPatch()` 把 `apply_patch` 的裸 unified-diff string 解析成多個 hunk → 各自 emit `fold_diff`，無法 parse 的 fallback 成 generic `fold_code` 顯示 raw patch。`workingDirectory` 必須傳進 `createSession`/`resumeSession` config（綁定 session lifecycle），否則 bash tool 會 `posix_spawnp failed`（GOTCHAS）。`/clear` eager-rebuild：dispose 舊 session + 立刻 `ensureSession()` 建新 session（帶當前 cwd），new sessionId 直接 emit `context_patch` 寫回 orchestrator，避免舊 session 的 workingDirectory 卡死。**Elicitation handler**：`registerElicitationHandler` 把 SDK 的 `session.ui.confirm/select/input/elicitation` 全轉 picker_request — `elicitationSchemaToPrompts()` 把 JSON Schema 7 field types 映射成 prompts，`picksToElicitationContent()` 反向 coerce 含 integer/number parseInt/parseFloat fallback；URL-mode decline + warn。**Packaged layout**：`@github/copilot` CLI 放 `extraResources/copilot-cli/`（不放 `asarUnpack`），閃開上游 `app.asar.unpacked.unpacked` path-replace bug — 詳見 GOTCHAS |
| Provider 純 helper（claude） | `providers/claude/helpers.ts` | 從 `claude/index.ts` 抽出的 side-effect-free 函式：`formatClaudeToolInput` / `rateLimitInfoToSegment` / `extractToolResultText` / `stripToolErrorWrapper` / `parseTaskCreateOutput` / `parseTaskListOutput` / `renderPlan` / `reconcileTasks` / `shouldAdoptResolvedModel` / `mergeClaudeModels` / `askUserQuestionToPrompts` / `buildAskUserQuestionAnswerJson`，以及 `TaskRecord` / `AskUserQuestion*` types（backend 反向 import）。`claude/claude.test.ts` 的純函式測試 import 這裡。**只被 `claude/` 內部 + 其測試引用**（封閉邊界）|
| Provider 純 helper（copilot） | `providers/copilot/helpers.ts` | 從 `copilot/index.ts` 抽出：`formatCopilotToolInput` / `quotaSnapshotToSegment` / `parseApplyPatch` / `elicitationSchemaToPrompts` / `picksToElicitationContent`，以及 `ApplyPatchFileSpec` / `Elicitation*` types。只被 `copilot/` 內部 + `copilot.test.ts` 引用 |
| Provider 共用 helper | `providers/shared.ts` | `stripCwd(p, cwd)` — 兩 provider 唯一 byte-for-byte 重複的純函式（formatter + file-edit card subtitle 共用）。providers/ 根下，跨 provider 共用 |
| Context persistence | `context-store.ts` | `loadContext()`、`saveContext()`、`deleteContext()`、`cleanupOldContexts()`，存放在 `~/.shelf/agent-context/{sessionId}.json`，atomic write（tmp+rename）。**Provider 不直接 import 這個 module** — 透過 `QueryInput.restoreContext` 讀、發 `context_patch` 訊息寫，由 orchestrator (`index.ts`) 統一處理。`lastSdkSessionId` 給 Claude（SDK `options.resume`）和 Copilot（`client.resumeSession()`）共用 |
| Context persistence 測試 | `context-store.test.ts` | `loadContext`/`saveContext`/`deleteContext` round-trip，含 Claude resume 指針 + Copilot Responses chain |
| Provider types | `providers/types.ts` | `ServerBackend`（含 `resetSession?()` / `resolvePicker?()`）、`SendFn`、`QueryInput`（含 `sessionId` + orchestrator hydrated `restoreContext`）、`OutgoingMessage`（含 internal `context_patch` 通知 orchestrator 持久化；`picker_request` 是多題互動 form — N=1-4 prompts、per-prompt multiSelect/inputType/options，給 Claude AskUserQuestion 攔截跟 Copilot elicitation handler 共用）、`PickerResolvePayload`（index-aligned answers 或 cancelled）、`ProviderCapabilities`。**SlashResult 已移除** — slash 經 `query()` 內 `parseSlashPrefix` 偵測後走 provider 內部 dispatch，輸出走 `fold_markdown` AgentMessage variant（DECISIONS #60）。`OutgoingMessage` 頂層也含 `{ type: 'plan'; content }` variant（plan side-channel，非 message timeline）|
| Slash prefix detection | `src/shared/slash-prefix.ts` | `parseSlashPrefix(prompt)` 共用 helper — provider 在 `query()` 入口偵測 `/cmd args` prefix；renderer (InputZone) 也 import 同份偵測 `OPTIONED_SLASHES`（/model /effort /permission）無 args 時開 picker。多行不認、bare slash 不認、cmd 名支援底線/數字 |
| Fake provider | `providers/fake/index.ts` | E2E-only backend，`SHELF_TEST_MODE=1` 時 `getBackend()` 不論 provider 都回它（agent-server/index.ts gate）。Prompt 走 prefix-matched scenario：`text:` / `thinking:` / `tool:` / `tool_err:` / `permission:` / `picker_single` / `picker_multi` / `picker_input` / `picker_number` / `auth_required` / `error:` / `delay:`，用 `\|` chain 多步。Picker resolve 後 echo `picker_answers:<json>` 給 spec assert。詳見 DECISIONS #58 |
| Fake provider 測試 | `providers/fake/fake.test.ts` | 每個 scenario 的 wire-shape 驗證 + stop/abort 行為 + canned prompt shapes |
| Bundle build | `build.mjs` | esbuild → `dist/agent-server/<version>/index.js` 單一 ESM bundle |
| 單元測試 | `providers/copilot/slash-commands.test.ts` | Slash dispatch（透過 `query()` 入口）：/help /context /compact /clear unknown + streaming/idle status pair 不帶 cost metrics |

### PM Agent (src/main/pm/)

| Intent | File | Description |
|--------|------|-------------|
| Barrel export | `index.ts` | 統一匯出 PM 模組所有公開 API |
| LLM 對話循環 | `agent-loop.ts` | 結構化 system prompt（角色/職責/工作流程/邊界 + 動態 Away Mode）、tool use loop、streaming、sliding window（透過 `trimHistoryForLLM`）、auto-retry（exponential backoff）、tab event 自動注入 |
| Sliding window helper | `history-window.ts` | `trimHistoryForLLM(history, maxTurns)` 切完後回退到 user boundary，避免裸切 function_call 觸發 Gemini 400 |
| LLM streaming client | `llm-client.ts` | OpenAI-compatible SSE streaming（用 Electron `net.fetch`），支援 tool_calls 解析 |
| Tool 定義 + 執行 | `tools.ts` | 10 tool schemas（L0 觀察 + L0.5 note + global note + write_to_pty）、`executeTool` dispatcher、`inferTabState` heuristic、Away Mode 過濾 |
| Scrollback ring buffer | `scrollback-buffer.ts` | Per-tab 100KB ring buffer、ANSI strip、lastNLines 讀取 |
| Note 儲存 | `note-store.ts` | Project notes（`<userData>/pm-notes/<projectId>.md`）+ global note（`<userData>/pm-global-note.md`）|
| 對話持久化 | `history-store.ts` | `<userData>/pm-history.json` 讀寫、app 啟動載入、每 turn 存檔 |
| Away Mode 狀態 | `away-mode.ts` | 全域 boolean + 同步到 renderer |
| 硬紅線檢查 | `redline.ts` | scrollback pattern match（rm -rf、git push --force、DROP TABLE 等） |
| Tab 狀態監控 | `tab-watcher.ts` | scrollback 狀態轉換偵測（cli_running → cli_waiting_permission 等）觸發 PM 自動事件；`snapshotTabs()` 給 `/status` 用 |
| PTY → PM bridge | `pty-bridge.ts` | `handlePtyData` / `handlePtyRemove` / `handlePtyClear` — pty-manager 的 `PtyObserver` 注入目標（P1-1 依賴反轉）。`handlePtyData` 先 `scrollback.append` 再 `tab-watcher.checkTab`（順序契約：watcher 讀 scrollback）。**不 import pty-manager**，接線在 index.ts |
| PTY bridge 單元測試 | `pty-bridge.test.ts` | 三種訊號路由到 scrollback/tab-watcher + append-before-checkTab 順序契約（守 P1-1 靜默壞掉風險）|
| Telegram bridge | `telegram.ts` | Bot API long polling、sendMessage、inline button（Allow/Deny、Away toggle）、slash commands（`/help` `/away` `/status` `/tabs` `/stop`）+ `setMyCommands` 自動註冊 |
| 單元測試 | `scrollback-buffer.test.ts` | Ring buffer + ANSI strip 測試 |
| 單元測試 | `tools.test.ts` | inferTabState heuristic 測試 |
| 單元測試 | `redline.test.ts` | 硬紅線 pattern match 測試 |

## Renderer (src/renderer/)

| Intent | File | Description |
|--------|------|-------------|
| Root 元件 / Event handler 中樞 | `App.tsx` | 載入 projects/settings、集中處理所有 event bus 事件、split view 渲染 |
| 全域狀態管理 | `store.ts` | `useSyncExternalStore` pattern，管理 projects/tabs/settings/UI state |
| Event bus | `events/` (`bus.ts` / `types.ts` / `ipc-agent.ts` / `index.ts`) | 簡單 pub/sub + 類型化的 `agent:*` event vocabulary + IPC ↔ bus 適配層（`bindAgentIPCGroup`）。`events.ts` shim 保留向下相容 |
| 快捷鍵系統 | `hooks/useKeybindings.ts` | combo string 對應 action，支援參數化 action（`switchTab_N`） |
| Paste/drop 上傳 hook | `hooks/useAttachmentPaste.ts` | 從 TerminalView 抽出的 paste/drop/upload pipeline，支援 file size check |
| Terminal 渲染 | `components/TerminalView.tsx` | xterm.js instance cache、PTY I/O、useAttachmentPaste hook、unread badge |
| Agent 對話 UI | `components/AgentView.tsx` (layout coordinator) + `components/agent/{MessageList,InputZone,StatusBar,DecisionPanel,PlanPanel,AuthPane}.tsx` + `agentTabStore.ts` + `agentTabSubscriptions.ts` + `agent-message-builder.ts` | 重構後架構（Decision #59）：AgentView 是 ~170 行 layout coordinator（lifecycle + handleConfigEdit + handleRetryInit）。Domain state（messages / status / capabilities / decisions / auth / init / queue / plan）在 `agentTabStore`（per-tab listener，避免 store.ts 的全域 snapshot 重建）。`bindAgentIPCGroup` 在 App.tsx mount 時把 IPC 接到 typed bus；`bindAgentStoreSubscriptions` 訂閱 bus → 寫 store。每個子 component 自己 subscribe useAgentTab(tabId)，InputZone 跟 MessageList 不共用 React 狀態（perf 修復根因 — input 打字不再 cascade re-render timeline）。子 component 間用 renderer-internal event `agent:scrollToBottom` 解耦。**Slash 分兩類**：agent-bound（/help /context /compact /clear）走 emit 'agent:send' → provider dispatchSlash；config（/model /effort /permission）由 `handleConfigEdit` emit 結構化 config-edit turn（`agent:send` 帶 `configEdit:{key,value}`）→ provider `applyConfigEdit`（DECISIONS #63），顯示/持久化由回傳的 capabilities 驅動，**無 renderer 樂觀更新**。**Prefs (model/effort/permissionMode) 是 renderer-authoritative** — projectConfig.agentPrefs 是 intent source of truth；store.actual* 是 backend reported display。Capabilities event 不 fall back 到 intent（修復 reconnect 時 actual 被 intent 蓋掉的 latent bug）。**Plan 走獨立 channel**（DECISIONS #60）：agent-server emit `OutgoingMessage { type: 'plan' }` → main `dispatchEvent` 走 `AGENT_PLAN` IPC → renderer `bindAgentIPCGroup` emit `agent:onPlan` → `agentTabSubscriptions` 寫 `setCurrentPlan(tabId, content)`，PlanPanel 直接讀 store.currentPlan，**plan 不進 timeline / AgentMessage union** |
| 選擇面板 | `components/SelectionPanel.tsx` | Bottom-anchored 單題 N-way 選單，permission popup + config picker（`/model` 之類，選定走 #63 config-edit turn）共用元件。Owns 鍵盤 cursor + ↑↓/Enter/Esc（cancellable）handler（capture phase）|
| Picker 面板 | `components/PickerPanel.tsx` | Bottom-anchored 多題互動 form。Provider 透過 picker_request 觸發（Claude AskUserQuestion 攔截、Copilot elicitation handler）。1-4 prompts 一次顯示一題、next button 導航；per-prompt single/multi-select + 當 `inputType` 設定時 always-visible 自填輸入框（text / number / integer，HTML5 type 對應 + integer 用 step=1）。鍵盤：↑↓ 永遠導航 options（input focus 也 blur）、Space toggle（input focused 時 native space）、Enter advance、Esc cancel。Streaming → idle 自動 dismiss（避免 ghost panel）。Pure helpers `initialStateFor` / `isComplete` / `packAnswer` 抽出做 unit test |
| Bottom bar | `components/BottomBar.tsx` | 顯示 connection type、cwd、git branch；branch dropdown 支援切換或跳轉 worktree project |
| Sidebar | `components/Sidebar.tsx` | Project 列表、拖曳排序、右鍵選單（含 New Worktree）、worktree branch 顯示、收合按鈕 |
| Tab bar | `components/TabBar.tsx` | Tab 列表、拖曳排序、雙擊重命名、unread badge、tab 顏色 |
| 快速指令選擇器 | `components/CommandPicker.tsx` | ⌘E 叫出 overlay，過濾 + 執行 per-project 快速指令 |
| 開發工具面板 | `components/DevToolsPanel.tsx` | ⌘D toggle 右側 panel，accordion 可收合，Base64/JSON/URL/UUID/Timestamp/Hash 工具，寬度可拖拉調整 |
| 資料夾選擇器 | `components/FolderPicker.tsx` | 兩步驟（connection type → browse），用 connector API |
| 資料夾瀏覽器 | `components/FolderBrowser.tsx` | 純展示元件，顯示目錄清單和 keyboard hints |
| Terminal 搜尋 | `components/SearchBar.tsx` | xterm SearchAddon 整合，Enter/Shift+Enter 搜尋 |
| Settings 面板 | `components/SettingsPanel.tsx` | 左側 tab 分頁（Terminal / Models / PM Agent / Shortcuts）；Models tab 顯示 PM 與 Claude 的 custom model entries；PM Agent tab 含 provider config + Telegram bridge |
| Worktree 建立 | `components/WorktreeDialog.tsx` | 輸入新 branch name 建立 git worktree，產生 sub-project |
| 刪除確認 | `components/RemoveConfirmDialog.tsx` | Remove project 確認 modal，worktree 可勾選是否清理 worktree files |
| PM 聊天面板 | `components/PmView.tsx` | 右側可拖拉 panel（訊息列表 + markdown 渲染 + streaming + tool call 摺疊 + Away Mode toggle + error 顯示）；chunk handling 走 `pm-view-reducer.ts` 的純 reducer |
| Notes 面板 | `components/NotesView.tsx` | ⌘N toggle 右側 panel，per-project markdown scratch pad（preview / edit toggle）；edit 模式 paste 圖片直接存檔 + 自動插入 ref；debounced auto-save；preview 走 `marked` + `shelf-image://` |
| Quick Note overlay | `components/QuickNoteOverlay.tsx` | ⌘⇧N 叫出 floating textarea，Enter 送出 / Shift+Enter 換行 / Esc 取消；paste 圖片支援（走 `parseDataTransfer` + `notes.saveImage` IPC，縮圖列下方顯示、可 ✕ 移除），純圖片也能送；走 `notes.quickCreate` IPC atomic 寫入當下 active project（title 自動 derive：先 `# heading` → fallback 第一行 trim 80） |
| Note 圖片縮圖 | `components/NoteImage.tsx` | 共用元件，NotesView 跟 QuickNoteOverlay 都用；透過 `notes.readImage` IPC 載 Blob URL，hover 顯示 ✕，URL lifecycle 由元件自己管 |
| Clipboard / drop 解析 | `utils/parse-data-transfer.ts` | 純 parser，`DataTransfer → PastedItem[]`；paste 跟 drop 同型別所以共用；text item 也帶 `isImage: false` 讓 consumer 可以直接 `.isImage` 判斷而不用 `kind === 'file' &&` 守衛 |
| 右側 sidebar toggle | `store.toggleRightSidebar(feature)` | PM / Notes / DevTools 三個 panel 共用同一個 toggle action（feature: 'pm' \| 'notes' \| 'devtools'）；sidebar button 永遠顯示，依狀態套 `.active` class |
| Tooltip 快捷鍵 helper | `utils/format-keybinding.ts` | 純函式 `formatCombo(combo, isMac)` / `tooltipWithShortcut(label, combo, isMac)`；`useKeybindings.comboToLabel` 內部 delegate 到這裡 |
| PM stream reducer | `components/pm-view-reducer.ts` | 純 reducer（`send_start` / `clear_display` / `dismiss_error` / `chunk`），管 streaming/streamText/streamToolCalls/error 四個 UI state；vitest 測 13 case |
| Project 編輯面板 | `components/ProjectEditPanel.tsx` | 改名、init script、default tabs、quick commands 編輯、Clear uploaded files |
| Agent UI 訊息持久化 | `storage/agent-history.ts` | IndexedDB（`idb@8.0.3`，DB v4 — refactor 時直接 drop + rebuild，不 migrate 舊資料）存 UI messages keyed by sessionId。Append-only delta save：`saveAgentMessagesDelta(sId, dirty, deletedIds?)` 寫變動、`loadAgentMessagesLatest(sId, limit)` 用 `by-session-time` index 倒序拉最新 N 條、`clearAgentSession()` 清整個 session。IDB 無上限（user 主動 clear 才減少）。Load 時 `reviveOrphanPending()` 把 `fold_*` 無 body 且無 errorMessage 的訊息（orphan pending）補成 `errorMessage='Session ended before completion'`，避免重啟後假 pending 卡死 |
| Canonical Agent message type | `src/shared/types.ts` (`AgentMessage`) | 9-variant discriminated union 採**渲染原語命名**（不挾帶 provider 語意）：inline 類 `reply` / `note` / `system` / `error` / `user`；可收合卡片類 `fold_text` / `fold_code` / `fold_markdown` / `fold_diff`（共用 `FoldBase` interface — `label` / `subtitle?` / `errorMessage?`）。Provider 自由決定渲染原語對應（例：thinking→fold_text、Bash→fold_code、Edit→fold_diff、/compact→fold_markdown、Copilot report_intent→note）。**`plan` 不在 union 內**，走獨立 `AgentEvent::plan` 直接寫 store.currentPlan。`fold_*` 後到的同 msgId 會 upsert body / errorMessage。`errorMessage` 有值強制 expanded 並顯示紅色 banner（override display setting）。設計 rationale 見 DECISIONS #60|
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
| Slash prefix parser | `slash-prefix.ts` | `parseSlashPrefix(prompt)` — agent-server providers 跟 renderer 都用同一份；multi-line 不認、bare slash 不認、底線/數字 cmd 名 |
| 單元測試 | `slash-prefix.test.ts` | `parseSlashPrefix` 邊界 case 覆蓋 |

## Config / CI

| Intent | File | Description |
|--------|------|-------------|
| Path alias 定義 | `aliases.ts` | `@shared` alias 的單一來源，vite/vitest config 共用 |
| Build 設定 | `vite.config.ts` | Vite + electron plugin、manualChunks 拆包、node-pty external |
| 單元測試設定 | `vitest.config.ts` | 獨立 vitest config（不繼承 vite.config.ts，避免載入 electron plugin） |
| 套件 / 打包設定 | `package.json` | electron-builder config、scripts、dependencies |
| CI/CD | `.github/workflows/build.yml` | Tag push → 三平台 build → GitHub Release；Windows build 額外 force-install `claude-agent-sdk-linux-x64`（WSL agent-server 需要） |

### npm scripts

| Script | 用途 |
|--------|------|
| `dev` | 開發模式（NODE_ENV=development，userData 加 `-dev` 後綴隔離） |
| `build` | Vite build + agent-server esbuild bundle，產出 `dist/` |
| `typecheck` | `tsc --noEmit` 型別檢查（不產出檔案） |
| `test` | 跑全部測試（typecheck → unit → e2e → docker → ssh） |
| `test:unit` | vitest 單元測試 |
| `test:e2e` | Playwright E2E 測試（自動 build，NODE_ENV=test 隔離 userData） |
| `test:docker` | Docker connector E2E 測試（自動啟動/清理 test container） |
| `test:ssh` | SSH connector E2E 測試（自動啟動/清理 test container） |
| `pack` | build + `electron-builder --dir`，產出 unpackaged app（userData 走 `-dev`，用於快速驗證 build） |
| `dist` | build + `electron-builder`，產出 packaged installer（吃 prod userData） |
| `dist:mac` | 同 `dist`，限 macOS 平台 |
| `dist:win` | 同 `dist`，限 Windows 平台 |
| `dist:linux` | 同 `dist`，限 Linux 平台 |
| E2E 測試 | `e2e/helpers.ts` | Playwright fixture、每 worker 用 tempdir + `--user-data-dir` 隔離 userData、`readActiveTerminalText()` helper。**fixture 預設帶 `SHELF_TEST_MODE=1` env**，讓 agent-server 走 fake provider。Agent helper：`openAgentTab()`、`sendAgentPrompt()` |
| E2E 測試 | `e2e/agent-picker.spec.ts` | Picker_request 全鏈：single-select、multi-prompt（含 multi-select+description+free-text）、cancel via Esc、free-text-only。走 fake provider 的 `picker_*` scenarios |
| E2E 測試 | `e2e/agent-flows.spec.ts` | 其餘 wire event 渲染：permission allow/deny、stream chunks → finalize upsert、fold_code/fold_diff 卡片（含 errorMessage）、auth_required pane、error message、雙 Esc stop mid-turn。走 fake provider |
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
