# DECISIONS — Agent Provider

Agent provider (Claude / Copilot)、wire protocol、Agent UI 架構、message type 設計相關決策。

編號保持歷史穩定（缺號表示已淘汰、併入 CLAUDE.md Conventions 或併入其他 decision）。跨檔 cross-ref 用 `DECISIONS #N` 直接 grep。

---

## 31. Agent View：兩 provider 都用各自原生 SDK + bundled CLI

**決策**: Agent tab 直接呼叫 AI provider SDK（不是解析 terminal scrollback）：
- Claude → `@anthropic-ai/claude-agent-sdk`，spawn bundled `claude` binary
- Copilot → `@github/copilot-sdk`，spawn bundled `@github/copilot` CLI（SDK 是 JSON-RPC wrapper，CLI 才是實際執行體）

兩者都在 `agent-server` bundle 裡執行，透過 stdin/stdout JSON line protocol 跟 main process 通訊。Binary 透過 `electron-builder` 的 `files` + `asarUnpack` 打包進 app（per-platform：claude-agent-sdk-{darwin|linux|win32}-{arch}、copilot-{darwin|linux|win32}-{arch}）。**Windows build 額外 force-install `claude-agent-sdk-linux-x64`**（CI step），因為 WSL agent-server 跑在 Linux 環境需要 linux binary；npm 的 `os` 限制阻擋 cross-platform install，用 `--force --no-save` 繞過。

**原因**:
- 之前用 terminal scrollback parsing 偵測 agent 狀態，TUI rendering 讓 stripped text 不可識別，永遠回傳 `cli_running`。直接用 SDK 拿到 structured state（idle/streaming/waiting_permission）。
- Copilot 試過 Vercel AI SDK（直打 `/chat/completions` + `/responses`）但 multi-turn 死路：Copilot 不支援 `store: true`、`previous_response_id`，replay history 又因 tool_call ID server 不認 404。Copilot CLI 本身解決了 stateful 對話，SDK 只是 wrap 它。
- 兩條路徑現在對稱：spawn bundled CLI binary、依賴使用者已有的官方 CLI 登入狀態（不經手 token）。

**不要改**:
- 不要嘗試自己對 Copilot 的 OpenAI-compatible endpoint 做 multi-turn — 已驗證走不通
- 不要把 binary 改成 runtime 下載 — 第一次使用會等很久，且需要 network；bundle 進 app 是體積換體驗

---

## 32. Agent Server 是 esbuild 單一 Bundle

**決策**: `agent-server/` 用 esbuild 打包成 `dist/agent-server/<version>/index.js` 單一 ESM bundle，deploy 到遠端（SSH: `~/.shelf/agent-server/index.js`，Docker: `/root/.shelf/agent-server/index.js`）。Main process 的 `remote.ts` 自動 SCP/docker cp。

**原因**: agent-server 依賴 Claude SDK / Copilot SDK，不能期望遠端有 node_modules。Single bundle 讓 deploy 只需要複製一個檔案 + `node index.js`。Binary（claude/copilot CLI）由 main process 從 ASAR unpacked 路徑解析後傳 cliPath 給 SDK。

**不要改**: 不要在遠端跑 npm install — 會拖慢啟動且需要 network。

---

## 33. Dual-Mode Tab State Detection

**決策**: Tab 狀態偵測分兩條路：Agent tab → `getAgentState()` 從 session manager 拿 structured state；Terminal tab → scrollback heuristic（既有的 `inferTabState`）。`resolveTabState()` 在 `tab-watcher.ts` 統一派發。

**原因**: Agent tab 有 structured state（SDK 直接回報），比 scrollback parsing 準確。Terminal tab 沒有 SDK，只能用 heuristic。兩者不互斥。

**不要改**: 不要嘗試統一成單一偵測機制 — agent tab 和 terminal tab 的資訊來源根本不同。

---

## 34. Agent Tab 固定 Provider，每 Project 每 Provider 至多一個

**決策**: Agent tab 建立時綁定一個 provider（claude 或 copilot），不可在 tab 內切換。UI 層限制同一個 project 不能開兩個相同 provider 的 agent tab（`addTab()` 檢查 + TabBar menu disabled）。Backend 透過 tabId-based session 管理，架構上不限制數量。

**原因**: Provider 切換涉及完全不同的 context/session 管理（Claude SDK session vs Copilot modelMessages），切換會丟前 provider 對話。固定綁定讓 sessionId 跟 provider 一對一。

**不要改**: 不要做 tab 內 provider 切換 — context 不相容。

---

## 35. Agent 雙層持久化：Server-side Context File + Client-side IndexedDB

**決策**: Agent 對話持久化分兩層：
- **Server-side**（`~/.shelf/agent-context/{sessionId}.json`）：Copilot 存 `modelMessages`（會被 compaction 壓縮）/ `lastResponseId` 用於 API 呼叫；Claude 存 `lastSdkSessionId` 作為 SDK `options.resume` 的指針（對話本體在 SDK 自管的 `~/.claude/projects/`），詳見 #38
- **Client-side**（IndexedDB `shelf-agent-history`）：存完整 UI messages（含 user messages、tool calls 展開等），用於重新開啟 tab 時恢復顯示

SessionId 是 UUID v4，存在 `ProjectConfig.agentSessionIds[provider]`，兩層用同一個 key。

**清理策略**：
- Server-side：agent-server 啟動時掃描，移除 `updatedAt` 超過 30 天 + 損壞 JSON
- Client-side：remove project 時清對應 session，不做定期掃描（在本機且跟 project 生命週期綁定）

**原因**: Server-side context 被 compaction 或 SDK 管理，無法恢復原始 UI。IndexedDB 在 renderer 直接可用，不需要 IPC round-trip。Context 檔在遠端機器累積無人清，30 天 cutoff 涵蓋合理 resume 需求。

**不要改**:
- 不要合併成單一 persistence — compacted data 無法恢復原始 UI
- 不要用 file 替代 IndexedDB — renderer 讀寫 file 需要 IPC
- 不要在 client 端觸發 server-side 清理 — 要走 IPC + SSH exec，太複雜

---

## 38. Claude Auto-Resume 純 Server-Side（含跨 process 持久化）

**決策**: Claude session resume 完全在 `agent-server/providers/claude.ts` 處理。

- **同 process 內**：SDK 回傳的 `session_id` 存在 `lastSessionId` 變數，下次 query 自動帶入 `options.resume`
- **跨 process（app 重啟、agent-server child restart）**：每個 turn 結束 `finally` 把 `lastSessionId` 寫入 `~/.shelf/agent-context/<sessionId>.json` 的 `lastSdkSessionId`；下次 process 啟動時 `seedSessionFromDisk(sessionId)` 把它讀回 `lastSessionId`，後續走原本路徑

Seed 時機：`gatherCapabilities` 結尾（tab 開啟時必跑）+ `query()` 入口（防 capabilities 被 cache short-circuit）。同一 sessionId 一個 process 只 seed 一次（`seededSessions` Set）。Client 端也可透過 `QueryInput.resume` 顯式覆蓋。

**原因**:
- Claude SDK 的 resume 機制只需要一個 session_id string，server 端自己追蹤最簡單
- jsonl 對話本體在 SDK 自管的 `~/.claude/projects/<cwd-hash>/<id>.jsonl`，**和我們的 `agent-context/` 共處同一台機器**（agent-server 在 local connection 跑本機、SSH/Docker 跑遠端，指針和本體永遠同處），所以指針持久化才有意義
- 一個 turn 寫一次盤（不是每 chunk）— 避免 disk thrash
- Crash mid-turn 最差只丟掉這個 turn，下次 resume 從上一個 turn 的 session_id 開始（SDK 一條 jsonl 內就含上次 turn 的全部 history）

**不要改**:
- 不要把 SDK session_id 暴露給 client — 增加 IPC 複雜度且沒有實際好處
- 不要每 chunk / 每 message 寫盤 — 一個 turn 一次足夠
- 不要把 `lastSdkSessionId` 存進 `projects.json`（project config）— 高頻寫入會 rewrite 整個 projects.json，且這是 backend implementation detail 不該污染 user-facing config
- Docker connection 是已知限制：container 重建即丟（`~/.shelf/agent-context/` 跟 jsonl 都在 container 內），不要為此繞回 main process 存（指針在本機沒用，因為 jsonl 在 container 內）

---

## 43. Agent Provider 行為對外保持一致，差異封裝在 Provider 內部

**決策**: 所有 agent provider（Claude / Copilot / 未來其他 OpenAI-compatible）對 renderer 暴露同一組介面（`gatherCapabilities`、`query`、`stop` 等）。Provider 之間的行為差異（model list 來源、slash command 語意、context 管理策略、auth 流程）一律封裝在 provider 內部。Renderer 對 provider type 無知。

**典型差異點**:
- **Model list**：Claude 寫死 / Copilot API 動態抓 / 未來 generic 由 user 配置 → 一律經 `gatherCapabilities().models` 出來，client 不用判斷怎麼來的
- **Slash commands**：provider 在 `query()` 入口自行偵測 `/cmd` prefix 並內部 dispatch（見 #54）— renderer 不分流
- **Context 管理**：Claude SDK 自管 / Copilot modelMessages + auto-compact → 都在 provider 內部
- **Auth**：Claude OAuth token / Copilot session token → 都包成 `auth_required` event

**原因**: 承 CLAUDE.md Conventions「Agent backend 封裝在 agent-server/」。具體效益：行為差異隔離後可分別演進（Copilot 加新 slash 不影響 Claude）；IPC contract 穩定（provider 內部重構不影響前端）。

**反例（不該這樣做）**:
- Renderer 寫死 `if (provider === 'copilot') ...` 攔截特定 slash command
- Renderer 知道某個 provider 的 model list 要動態 refetch、另一個不用
- Status bar 或 SettingsPanel 為某個 provider 開特殊 UI 分支
- IPC payload 帶 provider type 讓 main / agent-server 判斷怎麼處理

**例外**: 純 UI 呈現（例如 provider 名稱顯示為 "Claude" / "Copilot"）可以在 renderer 處理 — 那是 i18n 等級的東西，不是 agent 邏輯。

**不要改**: 不要為了「圖方便」在 renderer 加 provider-specific 條件分支 — 短期省 5 行 code，長期回頭重構要付 5 倍代價。新需求進來時先問「能不能塞進 provider 介面」，不行才考慮擴介面，最後才動 renderer。

---

## 45. Copilot 走 gh CLI auth，token 完全不經手

**決策**: `CopilotClient` 啟動時：
- `useLoggedInUser: false`（關掉 SDK 內建的 keychain/plaintext token 探測）
- 我們自己跑 `gh auth token` 拿 token，傳 `gitHubToken` 明確覆寫
- 沒有 gh / 沒登入 → throw 提示「`gh auth login -s copilot`」

**原因**:
- Copilot CLI 預設把 OAuth token 存 macOS Keychain（key=`copilot-cli`），首次從 Electron 內 spawn CLI 會跳 `node 想存取 copilot-cli` 的系統提示，UX 嚇人
- 跟 Claude 一致：我們不經手 token，依賴使用者本機官方 CLI（Claude Code / gh）的登入狀態 — Decision #43 的 provider 抽象原則
- `gitHubToken` 在 SDK 是「最高優先」覆寫，會跳過 keychain 探測那條 code path，**完全不觸發 macOS 提示**

**不要改**:
- 不要回去用 `useLoggedInUser: true` — 會跳 keychain 提示
- 不要自己存 token 到 userData — keychain ACL 是 per-binary 綁定，自存只是把 GitHub 的 OAuth refresh 邏輯重做一遍

---

## 46. Sticky Plan Panel：兩 provider 都接 plan 訊息

**決策**: AgentView 在 input 上方有個固定 panel，顯示當前 plan/todos 狀態。Backend 透過獨立 `AgentEvent::plan` event + `AGENT_PLAN` IPC channel 覆蓋式更新（不進 timeline；見 #60）。Replace-semantics（每次直接覆蓋整段內容），content 為空字串時 panel 隱藏。

**兩 provider 接法不同**：
- **Copilot**：`session.plan_changed` 事件 → debounced 呼叫 `session.rpc.plan.read()` → 發 `AgentEvent::plan`
- **Claude**（SDK 0.2.x）：攔截 `TodoWrite` tool_use，把 `todos` 陣列轉 markdown checkbox
- **Claude**（SDK 0.3.142+ 起）：`TodoWrite` 被 `TaskCreate / TaskUpdate / TaskGet / TaskList` 取代，是 delta-by-id 不是 snapshot。Provider 內維護 `tasks: Map<taskId, TaskRecord>` 鏡射 SDK task store，每次 Task* 事件處理完都呼叫 `renderPlan()` 整份重發 `{type:'plan', content:md}` — 對 renderer 維持 snapshot 介面不變
- **Claude**：`ExitPlanMode` 直接用 `input.plan` 字串（兩個 SDK 版本都一樣）
- 兩 provider 的 `/clear` 都要主動發空 plan event 清 panel（Claude 還要 clear `tasks` + `pendingTaskCreates` Map）

**原因**:
- Plan/todo 是「持續被 mutate 的單一 state」，不適合塞在 chat history 裡（會洗版、看不到當下狀態）— 因此走獨立 event channel 不進 message timeline
- Plan panel 跟 message list 視角互補：panel 顯示 latest，list 顯示 history（tool call 何時被呼叫）
- Replace-semantics 跟兩 provider 的原生語意都吻合（Copilot plan 檔覆蓋；舊 TodoWrite 每次傳完整 list；新 Task* 在 provider 內 cache + 整份重發，對外仍是 replace）

**不要改**:
- 不要把 plan 放回 message channel — 是 state update（替換語意）不是 timeline append
- Tool call 不要從 message list 拿掉 — history 視角有用（debug 時看時間軸）
- 不要把 plan panel 做成 collapsible inside chat — 用戶要的是「永遠看得到當前狀態」

---

## 47. Status bar 內容由 provider 決定，renderer 只渲染

**決策**: Status bar 的所有「provider 知識」欄位（rate limit、context %、permission mode、effort）改用統一 schema：
- **純顯示欄位** → `StatusSegment = { text, severity? }`，provider 把 label 翻譯、reset 倒數格式化、severity 判斷全包好，renderer 只做 `data-severity` → CSS color 對應
- **Cycle 欄位** → `CycleOption = { value, displayName, severity? }`，provider 決定每個 option 的顯示字 + 嚴重度，renderer 只負責 cycle UX（按鈕點下去切下一個 value）

Severity 是抽象層級：`'normal' | 'info' | 'warning' | 'critical'`，map 到 CSS 顏色集中在 `.agent-status-seg[data-severity="..."]`。

**原因**:
- Vocabulary 跟 UX 訊號是 provider 領域知識（`five_hour` / `premium_interactions` / `bypassPermissions` 各自的危險程度），散到 renderer 寫 `if rateLimitType === 'five_hour' ...` 就是 Decision #43 違反
- 但 cycle 行為（按一下切下一個）是 UI 互動，硬塞到 data model 裡反而過度抽象 — 所以分兩種 schema：純顯示用 `StatusSegment`，可互動用 `CycleOption`
- 共用 helper（`severityFromUtilization`、`formatResetCountdown`）放 `providers/types.ts`，避免兩 provider copy-paste

**配套**:
- Claude / Copilot 都自己決定 quota label（`5h` / `premium`）跟 severity 邊界（例如 Claude 的 `status: 'rejected'` 即使 utilization 50% 也算 critical）
- 100% 不 cap — overage 真實顯示成 `120%`（Copilot 月配額用爆會超過 100%）
- Permission mode 顯示字也由 provider 決定（`default → ask`、`bypassPermissions` 原樣 + critical 嚴重度）
- Renderer 完全不知道 `five_hour`、`premium_interactions`、`bypassPermissions` 等字串存在

**不要改**:
- 不要把 severity 換成 raw color（`'red'` / `'#e06c75'`）— 失去抽象，主題切換時改不到位
- 不要把 cycle 結構也包成 `StatusSegment` — cycle 行為是 renderer 領域，過度抽象沒效益
- 不要在 renderer 寫 quota / mode 的特殊翻譯（例如 `if (mode === 'plan') color = blue`）— 這是 provider 該決定的，severity 已經傳達意圖

---

## 48. Agent provider custom model registry — Claude merge SDK + user，Copilot 簽名對稱但忽略

**決策**: `gatherCapabilities(cwd, sessionId, customModels?)` 簽名統一加 `customModels?: ProviderModel[]`。Claude 用 pure `mergeClaudeModels()` 把 SDK 動態 list 跟 user 自訂 entry 合併（同 id 以 user 覆寫）；Copilot 簽名收下但函式內忽略 + 註解。

`AppSettings.providerModels` key 從 `PmProviderType` 廣化成 `PmProviderType | 'claude'`。Settings UI 用 `AGENT_PROVIDER_REGISTRY`（目前只有 Claude）多渲染一個 section，行為跟 PM provider section 一致。Main 在 `startSession` 時 `loadSettings()`，把 `providerModels[provider]` 透過 `getCapabilities` → IPC → agent-server 傳到 backend，session 內 closure cache（user 改 settings 要重開 agent tab 才生效，不做 hot reload）。

**原因**:
- Claude SDK `supportedModels()` 只回 4 個 alias，抓不到舊版 full ID（如 `claude-opus-4-6`）。User 要舊版又不想我們寫死預設 list（會跟 SDK drift）
- Copilot SDK server-side 驗證 model 名稱，custom 會被拒；介面對稱但忽略比 throw 更乾淨，未來 API 改了拿掉 `_` 前綴即可

**不要改**:
- 不要在 Settings UI 列 SDK 預設 model — 會 drift；Models tab 只列 user 自訂 entry
- 不要把 Copilot 塞進 `AGENT_PROVIDER_REGISTRY` — SDK 會拒，UI 給 user 設了沒效果只會誤導
- 不要在 renderer 直接讀 settings — 走 main 的 `loadSettings`，避免 renderer 感知 main 的 storage layout

---

## 49. Permission semantics 全部收進 provider，dispatcher 只做 IPC routing

**決策**: 所有跟 permission 相關的行為細節（bypass 短路、acceptEdits 自動允許、plan mode 阻擋、session allowlist「always allow this tool」）都實作在 `agent-server/providers/<name>.ts` 裡。`agent-server/index.ts` (dispatcher) 不存任何 permission 狀態、不做任何 mode 判斷，只負責 IPC routing 和 backend lifecycle。

**原因**:
- 承 CLAUDE.md Conventions + #43。具體在 permission 領域：兩 provider SDK 對 permission 支援深度不一樣（Claude `updatedPermissions` addRules destination=session / Copilot `kind`-based + native `autopilot`），硬抽到 dispatcher 會走最低公分母、放棄各自 SDK 最原生機制
- session allowlist 在 Claude 是「白送」（回 `updatedPermissions` 後 SDK 自己接管，連 `canUseTool` 都不會再 invoke）；dispatcher 一律「自己存 Set」就丟掉這個白賺

**配套**:
- `bypassPermissions`：Claude 在 `canUseTool` 開頭 short-circuit auto-allow，SDK 的 `permissionMode` 一律送 `'default'`（避開 `allowDangerouslySkipPermissions` 旗標）；Copilot 走 native `autopilot` SessionMode
- `plan` / `acceptEdits`：Claude 透傳 SDK（兩者 SDK 內建語意非平凡，不要重造）；Copilot adapter 自己決定怎麼對應（`acceptEdits` 目前無對應就從 capability list 拿掉，"honest capability surface"）
- session allowlist (未來)：Claude 用 SDK `updatedPermissions: [{type:'addRules', destination:'session', ...}]`；Copilot 看 SDK 支援度，沒對應就 provider 內 closure `Set<string>` fallback
- Permission popup 第三按鈕「Allow for session」由 renderer 加，但「session allow 之後怎麼記住」是 provider 的責任
- **Capability descriptor（label / severity）走中央定義**：`PERMISSION_MODES` / `EFFORT_LEVELS` 放 `agent-server/providers/types.ts`，provider 用 `pickPermissionModes(['default', 'plan', ...])` 宣告支援哪些 ID。Provider 自證「我支援什麼」，不重複定義 displayName 或 severity（那是 app 層級的 UX 一致性）

**不要改**:
- 不要在 dispatcher 加 `Map<provider, Set<toolName>>` 之類的 cross-provider permission 狀態 — 看似 DRY，實際上強迫所有 provider 走最低公分母
- 不要為了「對稱」逼 Claude 不用 `updatedPermissions` 改自己存 Set — SDK 白送的不要不拿
- 不要把 SDK 的 `allowDangerouslySkipPermissions` 旗標當 bypass 入口 — 我們在 `canUseTool` 內 short-circuit 就好，不需要 SDK 安全鎖（也避免 user 認為「真的有開危險模式」）
- 不要把 `bypassPermissions` 邏輯放 renderer（auto-resolve permission_request 也算）— 每個 tool 多一次 IPC round-trip，純粹浪費；且分散後 audit/telemetry 難加


## 53. Wire protocol envelope: per-event `turnId` for main-side turn routing

**問題**: 舊 `OutgoingMessage` 是 free-form `[key: string]: unknown`，沒有 envelope 標識「這個 event 屬於哪個 query turn」。`src/main/agent/remote.ts` 用單一 `lineHandler` setter 接收 stdout — 每個新 query 上來覆寫前一個的 handler。當 agent-server 在 turn N 結束後**延遲**發出 event（譬如 claude.ts `result` handler 發完 idle、`finally` block 又補一次），這個 leftover event 會被 turn N+1 剛裝好的 handler 吃掉，誤判成自己的 idle → for-await 立刻結束 → turn N+1 真實 events 沒人讀（queued msg bug 的根因）。

**決策**: 每個 per-turn wire event 帶 `turnId: string` envelope。

- Main 端在 `query()` 入口生成 turnId（`t-${randomUUID().slice(0, 8)}`），透過 IPC `send` payload 餵給 agent-server
- agent-server 的 `handleSend` 從 incoming msg 拿 turnId（缺則 fallback 新生），用 `wrapSendForTurn(turnId, send)` 包 send 函式 — 自動在所有 outgoing event 上 stamp turnId
- Provider 完全不感知 turnId（透過 closure 帶過去）
- Main 端的 `createTurnDispatcher`（`src/main/agent/turn-dispatcher.ts`）取代舊 `streamRemoteEvents`：單一全域 stdout listener 按 turnId 路由到 per-turn `AsyncGenerator`，turn 結束後 unregister；任何後續帶舊 turnId 的 event 找不到接收者就 log + drop
- Lifecycle events（`ready` / `pong` / `capabilities` / `credential_*`）在 turn 外部，turnId 是 optional — 由 requestId 或單一 dispatcher 處理

**配套 envelope**: `AgentMessage` / `stream` payload 另帶 `msgId`（per-message-block 識別碼，不同於 per-turn 的 turnId），讓 stream chunks 跟 finalize 在 renderer 對齊到同一 timeline entry（store 上的 upsert key）。`OutgoingMessage` 同時從 free-form 收緊成 discriminated union。

**不要改**:
- 不要為了 backward-compat 加 fallback「沒 turnId 就分配給 currentTurn」— 這正是舊 single-lineHandler 模型的 bug 來源
- 不要在 provider 端 dedupe idle — turn-dispatcher 已從根上擋下，不需要二次防線
- 不要把 turnId / msgId 暴露給 renderer-side AgentMsg.id 以外的用法 — 它是 store 的 upsert key，不該洩漏到 UI 行為決策（如「if id starts with t- 就...」）



## 54. Slash commands: provider-internal dispatch, not RPC channel

**決策**: Slash 是 provider 想特別解釋的字串，**不是獨立 channel**：

- Renderer 不偵測 slash — `agent.send(text)` 一條路徑通吃普通 text 跟 `/cmd`（config picker 走 #55/#63 的結構化 config-edit turn，是「按鍵級 config edit」不是 agent command）
- Provider 在 `query(input, send)` 入口呼叫 `parseSlashPrefix(input.prompt)`，命中走內部 `dispatchSlash(cmd, args, send)`
- Slash 輸出走 `fold_markdown` 渲染原語（label 是 `/cmd` 名、失敗用 `errorMessage`；見 #60）
- Backend interface 只剩 `query(input, send)`，沒有 `handleSlashCommand`

與 #60 一致：renderer 給框、provider 給內容。Lifecycle 對齊：slash 在外部就是個 turn，streaming → idle，跟 `queuedMessages` queue 邏輯共用、不需插隊。

**Stop 行為**: `stoppable` flag 是 provider-internal、不上 renderer。`/compact` 整個 SDK turn、`/clear` 的 dispose+rebuild 都用 `critical()` helper 包成 non-stoppable，stop() silently no-op（avoid leaving SDK in half-compacted state）。對齊業界（Cursor / Claude Code / Aider）「stop 按鈕永遠在、能不能停由 provider 決定」。

**不要改**:
- 不要把 SlashResult / slash_command RPC 通道復活 — 那條路就是這次砍掉的對象
- 不要為了 fast-path 給 `/help` 開特例（不走 query()）— 統一 lifecycle 比省幾 ms 重要
- 不要把 slash 偵測搬到 orchestrator 或 main 端 — 違反「provider 自主決定要不要解釋 prefix」（未來 Claude 想加 `\help` 之類也行）
- 不要在 renderer 加「stoppable」UI 狀態 — 加了就回到 RPC 心智模型、違反 message stream 一致性


## 55. Slash command routing + prefs flow

**默認規則**：所有 slash 都送 provider — 不管 provider 認不認得。Renderer 只在一種情境內留手：`OPTIONED_SLASHES`（`/model` `/effort` `/permission`）**無 args** 時開 inline picker 從 capabilities 取選項（省一趟 backend 來回）。其他狀況一律 fall through 給 provider。

### 流程

```
user types "/cmd [args]"
    ↓
InputZone parseSlashPrefix
    │
    ├─ cmd ∈ OPTIONED_SLASHES && !args
    │     → 開 inline <SelectionPanel>（從 capabilities 取選項）
    │       picker 選定 → handleConfigEdit → 結構化 config-edit turn（#63）
    │       → provider applyConfigEdit（divider + capabilities，非 renderer-local）
    │
    └─ 其他狀況（含 OPTIONED_SLASHES with args、/help、/clear、未知 slash）
          ↓
       upsertMessage(user) + emitAgent('agent:send', { text: "/cmd args", prefs })
          ↓
       agent-server handleSend
          ↓
       applyPrefDiff (read renderer's prefs from payload, call backend.setX? on diff)
          - cache 只在 setX 成功時 update（失敗下次 retry）
          ↓
       backend.query(input)
          ↓
       provider 自己 parseSlashPrefix(input.prompt)
          │
          ├─ provider 認識 → imperative apply + fold_markdown (pending → success/error)
          │                 + 必要時 send({ type: 'capabilities' })
          │
          └─ 不認識 → fold_markdown errorMessage: "Unknown command: /cmd"
```

### Prefs (`model` / `effort` / `permissionMode`) 的擴充行為

走「**renderer 發起 → provider 執行 → 廣播 capabilities → renderer 落地**」：

- 打字 slash with args 走 provider slash（如上圖）；picker / status-bar 走結構化 config-edit turn（#63）。兩者最終都到 provider `applyConfigEdit` → re-broadcast capabilities，**無 renderer 樂觀更新**
- Renderer `AgentView` 用 useEffect 觀察 capabilities，跟 savedPrefs 比較，差異才 `persistPref` 寫進 `projectConfig.agentPrefs`
- Backend 拒絕的值不會被 broadcast → 不會 persist。**Disk 永遠是 backend 確認過的真相**

**Provider 差異**：
- Copilot：slash handler 內 `await session.setModel(args)` — SDK 驗證即時，失敗就 emit error
- Claude：per-call options 設計，slash handler 只更新 closure + broadcast（永遠成功；validation 推到下次 query SDK 收到時）

### 配套 invariants

- `setModel` closure mutation **必須在 SDK 確認後才執行**（Copilot Bug 1 教訓 — 之前先改 closure 再 await session.setModel，throw 時 closure 跟 SDK session 永久脫鉤）
- `applyPrefDiff` 的 `lastAppliedPrefs` cache **只在 setX 成功才 update**（Bug 2 教訓 — 之前失敗也 cache，下次 retry 被誤判 no-op）
- `OPTIONED_SLASHES` value 是 picker key（跟 SelectionPanel / prefs key 對齊）；slash name 可能不同（e.g. `/permission` → `permissionMode`）— 為了 typing 短

### 不要改

- 不要把 prefs 改回「renderer optimistic apply + 不問 backend」 — bug 來源（dirty state 落地 + status bar 跟 backend 不一致）
- 不要在 renderer 端攔截「unknown command」— 該讓 provider 回，user 才知道 slash 被 dispatch；renderer 攔截 = provider-specific slash 死路
- 不要在 renderer 加 model validation against capabilities — SDK 是唯一仲裁者（Claude `supportedModels()` 會隱藏但實際接受 legacy models）
- 不要在 provider 內 setX 做 diff — orchestrator 已做
- 不要在 capabilities-driven persist 加 throttle/debounce — capabilities event 自然就是「有變化才 broadcast」，下游沒 spam 風險


## 57. Picker_request 收編 AskUserQuestion / Elicitation 為多題互動 form

**決策**: `picker_request` 是 agent 主動發起的多題結構化 form 唯一 channel：
- Wire shape：`prompts[]`（N 題）+ per-prompt `multiSelect` + `options[]` + 可選 `inputType: 'text' | 'number' | 'integer'`（設定後 renderer always-render 一個自填輸入框，覆蓋 AskUserQuestion 的隱含 Other auto-add）
- `PickerResolvePayload`：`{ answers: Array<string | string[]> }` index-aligned 或 `{ cancelled: true }`
- Claude：`canUseTool` 攔 `toolName === 'AskUserQuestion'`，轉 picker_request，SDK output JSON 塞 `{ behavior: 'deny', message }` 餵回 model（GOTCHAS 有 hack 說明 + 回歸測試）
- Copilot：`registerElicitationHandler` 接 ElicitationSchema 7 field types → picker_request prompts

**不要改**:
- **不要把 permission 跟 picker channel 合併** — permission 的 "Allow/Deny/Allow and remember" 字串是 app-owned 需 i18n、picker label 是 agent-supplied 不能翻譯；resolve shape 也不一樣（`{behavior, scope?}` vs `{answers}`），合併要寫 adapter。Ownership 邊界從 channel 層退到 field-level discriminator 比分兩個 type 還醜
- **不要在 renderer validate 數字 min/max** — SDK 是仲裁者，validation 失敗 LLM 自己會 re-prompt
- **不要把 AskUserQuestion 加進 disallowedTools 退回純文字** — 我們已有 picker UI 跑完整流程

**驗證資產**:
- `scripts/spike-askuser.ts` — SDK 升級時跑一次驗 canUseTool deny+message hack 仍 work
- `agent-server/providers/{claude,copilot}.test.ts` — wire transformation 單元測試


## 58. Fake provider 作為 E2E 入口、fixture per-test scope

**決策**:
- **agent-server 內建 fake provider** (`agent-server/providers/fake.ts`)，speak 同一個 `ServerBackend` interface + 同一組 `OutgoingMessage` shape — 沒有 test-only event，凡 fake 能 emit 的事 real provider 都可能 emit
- **`SHELF_TEST_MODE=1` hijack 模式**：env 開時 `getBackend()` **不論 renderer 要哪個 provider** 都回 fake。Renderer 維持 `claude`/`copilot` 選項，但 wire 鏈走 fake。Production build 沒設 env → fake code dead branch
- **Scenario syntax**: prefix match + `|` chain（`text:hi|delay:30|tool:Read`），文件在 `fake.ts` JSDoc
- **Picker resolve 驗證走 echo**: fake 解 picker 後 emit `text` message `picker_answers:<json>` 或 `picker_answers:cancelled`，spec assert echo（避免戳 renderer 內部 state）
- **Playwright fixture per-test scope**（不是 worker scope）：每 test 新 Electron + tempdir

**不要改**:
- **不要把 fake.ts 改成跟 real provider 不同的 wire shape** — 整套保證來自「same wire 鏈、不跳層」
- **不要回到 worker-scoped fixture** — `project-creation.spec.ts` 後半段、`app-startup.spec.ts:22 no projects on fresh start`、`notes.spec.ts:103 manual title overrides` 會立刻壞
- **不要在 renderer 暴露 fake provider** — hijack 是底層替換，UI 保持跟 production 一樣的路徑
- **不要改成「register fake as a third provider」** — 會逼 `AgentProvider` union 改 shared/types.ts、persistence schema、Settings UI 都動，contained boundary 失守

---

## 59. Agent View 採事件 / Store 分離架構（InputZone 與 MessageList 間接相依）

**決策**: AgentView 不該是擁有所有 state 的 god component。正確架構是：

```
InputZone ──emit('agent:send', ...)──▶ EventBus
                                        ↓
                              App.tsx handler:
                              - agentTabStore.appendUser(tabId, ...)
                              - shelfApi.agent.send(tabId, ...)
                                        ↓
                              agentTabStore (per-tab)
                                        ↓ subscribe
                              MessageList (純 render)
```

職責分配：
- **InputZone** — 收輸入、emit event，**不知道 MessageList 存在**
- **MessageList** — subscribe store、純 render，**不知道 InputZone 存在**
- **EventBus** — 傳遞 action，不存 state（已存在 `src/renderer/events.ts`）
- **App.tsx handler** — 統一處理 IPC + 寫 store（對位 CLAUDE.md Conventions「side effect 集中 App.tsx」）
- **agentTabStore** — per-tab scoped，唯一 message state

兩個 sibling 間 **間接相依**：input 送出的訊息透過 store 流到 MessageList，沒有 prop 直接串、沒有共享 state 持有者。

**原因**: 承 CLAUDE.md Conventions「sibling 元件間接相依」。具體效益：
- MessageList subscribe store slice → 只在 messages 變化時 re-render，input 打字不波及；不需要手動 memoize 一堆 props
- Tab unmount 才安全：messages 在 store 不在 component state，non-active agent tab 可 unmount 釋放記憶體不掉資料

**為什麼是這個架構而不是其他**:

| 選項 | 為什麼不採用 |
|------|------------|
| 父層 coordinator + 共享 state | 父層 state 變化照樣 cascade re-render，沒解決問題 |
| 直接 props 串 input ↔ messages | 耦合最緊，違反「sibling 不該知道對方」 |
| 純 event bus（messages 也走 event） | event bus 不適合存 state，messages 需要 source of truth |
| 純 store（input 也直接寫 store） | input 直接呼叫 store API，比 event bus 緊耦合；side effect routing 不明 |
| **Hybrid（採用）** | 動作走 event bus、狀態走 store，職責清晰 |

**不要改**:

- **不要把 input 跟 MessageList 透過共同父層 state 串** — 父層 state 變化照樣 cascade re-render，沒解決問題
- **不要把 messages 留在 component state、其他搬 store** — tab unmount 會掉資料
- **不要把 handleSend 留在 InputZone** — 違反 CLAUDE.md「side effect 集中 App.tsx」，handler 該在 App.tsx

**Related**:
- `.agent/features/agent-view-perf.md` — perf 問題的根因記錄
- Decision #50 — Per-project storage


## 60. Agent Message Type 渲染原語化（9-variant union + Plan side-channel）

**決策**: `AgentMessage` discriminated union 從「provider 語意命名」（thinking / tool_use / file_edit / intent / slash_response / plan / text / system / error / user）重構成「**渲染原語命名**」9 個 variant，plan 從 message channel 抽出成獨立 AgentEvent。

新 union：
- 純 inline：`reply` / `note` / `system` / `error` / `user`
- 可收合卡片（共用 `FoldBase` interface）：`fold_text` / `fold_code` / `fold_markdown` / `fold_diff`
- **`plan` 不在 union 內** — 走獨立 `AgentEvent::plan` + `AGENT_PLAN` IPC channel → 直接寫 `agentTabStore.currentPlan`，永遠不進 timeline

**原因**:
- 承 CLAUDE.md Conventions「wire payload 是渲染原語不是 provider 語意」— 舊 union 把 thinking / tool_use / slash_response 等 provider 語意洩漏進 renderer；渲染視角下「可收合卡片」是同個 UI primitive，差別只在 body format
- 新增類似 entity 要新 type：未來加 MCP rich output、custom slash 等都要 variant + builder case + renderer case + CSS class
- 語意洩漏到 settings：舊 `AgentDisplayKey` 是 `thinking|tool_use|file_edit|intent`，使用者要記「Tool Use」對應到哪些工具；新 key 是 4 個 `fold_*`、跟 body format 1:1
- `slash_response` 跟 `tool_use` 結構同形但分兩個 type 是歷史包袱；`file_edit` 成功/失敗用不同 body shape 本來就該共用 fold 殼（這四個舊 type 都已併入新 fold_* 系列）

**Key Q-locked 決策**:
- **`note` marker（▸）由 renderer 渲染** — provider 只給純內容，視覺契約跟 `error` 紅色 / `reply` markdown 同層級
- **`subtitle` 截斷由 CSS 處理** — provider 給完整字串、renderer CSS truncate + `title={subtitle}` tooltip 給 hover 看原文，不在 provider 截斷
- **`errorMessage` 兩層分工**：
  - `fold_*` 卡片的 `errorMessage`：tool/action/slash 業務失敗（Bash exit 1、Edit old_string not found、/compact 失敗），紅色 banner inline 在卡片內
  - `AgentEvent::error` (無 msgId)：transport/framework 失敗（連線斷、agent-server 沒起來、JSON parse fail），main 端 `dispatchEvent` mint msgId 轉成 renderer `error` message
  - `OutgoingMessage msgType='error'`：provider 業務層錯誤（已有 turn 上下文）
- **`fold_code` vs `fold_markdown` 區分**：markdown 是否解析。`fold_code` 用 `<pre>` 不解析（shell stdout、raw output 含 `*` `#` 不會誤判）；`fold_markdown` 解析 markdown（slash 結果、MCP rich text、想顯示 code 包 ```lang fence）— **不另開 `fold_json`**
- **`FoldBase` interface 共享** label / subtitle / errorMessage，避免四個 fold 重複定義
- **`errorMessage` 強制 expanded** override 任何 display setting — 「失敗一定要看見」沿用既有原則
- **不做 hidden** — `collapsed` 留 header 在 timeline 事後 trace；hidden 違反「不在意但回頭要找得到」原則
- **Plan 抽出獨立 event channel**：plan 是 state update（替換語意，當前 plan = X），不該擠進 timeline；error 不像 plan 抽出是因為它兩層都該進 timeline（差別只在來源層級）
- **Streaming flag 留在 `WithMsgId` 最外層** — 是 lifecycle metadata 跟 msgId 同類，不是 content 屬性。實際只有 `reply` / `fold_text` 會用，其他 type 不設

**不做 migration**:
- User = developer，IDB 歷史可棄
- Settings 舊 key (`thinking` / `tool_use` / `file_edit` / `intent`) 直接拿掉、不轉換
- IndexedDB version bump v3 → v4，upgrade handler drop old store + 重建

**不要改**:
- 不要在 renderer 加任何「if (toolName === ...) special case」分支 — 渲染決策走 type，type 決策已在 provider
- 不要把 plan 放回 `AgentMessage` union — plan 屬性是「替換式 state update」、不是 timeline append
- 不要把 `fold_*` 收回成單一 `fold` type + `bodyFormat: 'text'|'code'|'markdown'|'diff'` discriminator — TS narrowing 變兩層，format-specific 欄位擴充會污染其他 fold 類
- 不要在 renderer 解析 label / content 語意（例如「label === 'Thinking' 就顯示閃爍 caret」）— 動態 affordance 純靠 `streaming` flag + body cursor
- 不要為 errorMessage 也加獨立 setting key — 永遠強制顯示，不暴露關閉選項

**Related**:
- `.agent/features/agent-message-type-refactor.md` — 完整重構規劃與 phases
- Decision #54 — Slash 內部 dispatch（slash_response type 廢除、改 emit fold_markdown）
- Decision #46 — Plan panel（從 message channel 攔截改成獨立 event channel）

---

## 61. Provider 格式解析失敗一定要 fail-loud（console.error log）

**決策**：任何 provider 端的 wire-format 解析（SDK tool_result content、apply_patch 字串、自訂協議 payload）失敗時，**必須在 caller 端 `console.error` 記錄 content preview**（前 200~300 字）。不要靜默 return null/fallback。

**適用範圍**：
- `parseTaskCreateOutput` / `parseTaskListOutput`（Claude 0.3.142+ Task 系統）
- `parseApplyPatch`（Copilot apply_patch）
- 任何未來新增的 SDK-output 解析 helper

**為何**：SDK 版本升級時 type def 跟 runtime 不一致很常見（已踩過 TaskCreate 是 text 不是 JSON、AskUserQuestion is_error 透傳變化）。沒有 log 時：
- Plan panel 莫名空白
- diff 卡突然變 raw 字串
- 用戶 / dev 都不知道原因，debug 從零開始

有 log 時：升版後第一次踩到立刻看到 `[provider] X parse failed; format may have changed { contentPreview: '...' }`，5 分鐘修。

**設計細節**：
1. **Pure parser 自己不 log**（保持可組合、可測），return null
2. **Caller 在「已知該成功的路徑」上 log** — 例如註冊過 tool_use_id 的 tool_result 才 log，避免對任意 result 都嘗試 parse + log（noise）
3. **預期 silent path 例外** — 例如 `parseApplyPatch` 對 Delete File 回 null 是設計如此，caller 用 marker 偵測排除這條再 log
4. **不走 wire**：用 `console.error` 寫 stderr，由 `src/main/agent/remote.ts` stderr handler 進 logger，不送到 renderer（不是 user-facing error）

**反例**（不要做）：
- 在 pure parser 內部 `console.error` — parser 應該可組合測試，log 是 caller 的責任
- 把 silent fallback 改成 throw — provider 不該因 wire 格式變化整個 turn 失敗
- 在 renderer 端 log — 訊號到那邊已經晚了，且 wire 已經把 fallback 形式送過去

**Related**：
- `.agent/GOTCHAS.md` — Claude SDK 0.3.x TaskCreate text 格式 / AskUserQuestion is_error 透傳
- `agent-server/providers/claude.ts:parseTaskCreateOutput / parseTaskListOutput` 範例
- `agent-server/providers/copilot.ts:parseApplyPatch` caller 範例

---

## 62. Model 顯示：intent-driven，alias 不被 per-turn 解析值覆蓋

**背景**：Claude SDK 0.3.x 的 `supportedModels()` 回傳的是「推薦 alias」清單（runtime 拿、非寫死）：`default`（= recommended，現為 opus 4.8）/ `sonnet` / `haiku`。**清單裡沒有 `opus`**。使用者選 alias 後，SDK 每個 turn 回報的 `message.model` 是解析後的具體 id（如 `claude-opus-4-8`，init 甚至帶 `[1m]` 標記）。

**問題**：舊邏輯把 per-turn 解析的具體 model 經 status 事件灌進 `actualModel`，導致 flip-flop：選 `default` → query 後顯示 `claude-opus-4-8` → 重啟又變 `default`。

**決策**：status bar 顯示的 model 是 **intent**（使用者選的），由 capabilities channel + intent seed + 明確 edit 驅動，**per-turn status 不帶 model**。再依 intent 性質分流：

- **intent 是 alias（在 `supportedModels()` 清單內）** → 永遠顯示該 alias，不被解析值覆蓋。`default` 維持「跟著 recommended 走」語意，不 pin 死、重啟一致。
- **intent 不是 alias（使用者 pin 了具體 / custom id）** → 採用 SDK 實際回報的 model，promote 到 `currentModel` 並重發 capabilities → 顯示 + project config 都更新成實際 model。

判斷邏輯抽成 pure helper `shouldAdoptResolvedModel(resolved, currentModel, aliases)`（claude.ts），query loop 呼叫。守備：synthetic `<...>` 跳過、unchanged no-op、`currentModel` 未設視為 unpinned 不 promote、alias 清單未填（warmup 未完）不 promote 避免誤判。

**為何不 pin alias**：
1. `default` 字面意思就是 recommended — pin 死等於放棄追新（4.9 出來跟不上）
2. 解析 id 帶 `[1m]` 等標記，不保證是合法 `--model` 輸入，餵回 API 可能壞
3. 清單沒 `opus`，選 alias 是「我要推薦的」不是「我要這個特定版本」

**不要改**：
- `setStatus` 不要再加 model 欄位 — 顯示走 capabilities，避免 per-turn 覆蓋
- 不要在 renderer 判斷 alias vs 具體 id — provider 有 `cache.models`（SDK 清單）才是權威，renderer 的 `capabilities.models` 含 custom models 會誤判
- 不要為了「想看 default 實際跑哪版」把解析值 persist 進 `agentPrefs.model` — 那會 pin 死 alias；要顯示就走 annotation（另開 `resolvedModel` 欄位，未實作）

**Related**：
- `agent-server/providers/claude.ts:shouldAdoptResolvedModel` + query loop promotion
- `.agent/GOTCHAS.md` — SDK init.model 是解析後具體 id（帶 `[1m]`）不是 alias

---

## 63. Config 變更統一走 provider applyConfigEdit（職責歸位）

model/effort/permission 三個入口（打字 `/model X`、picker、status-bar 點擊）都收斂到 provider 的 `applyConfigEdit`（set value + emit capabilities + emit `system` divider，文案 `src/shared/config-ack.ts`）。打字走 `query()` parseSlash；picker/status-bar 走 `handleConfigEdit` emit 結構化 config-edit turn（`agent:send` 帶 `configEdit:{key,value}`、無 echo）→ `QueryInput.configEdit`。

本質是把 config 變更的語意還給 provider，renderer 不再 renderer-local 樂觀模擬（取代 #55 picker 那條 renderer-local 路）。

**不要改**：
- 不要在 `handleConfigEdit` 加回樂觀 `setActual*`/`persistPref` — 會跟打字的 round-trip 行為分歧。顯示/持久化一律由回傳的 capabilities 驅動
- renderer 送結構化 `{key,value}`，不要組 `/model X` 字串（slash 語法留在 provider）；也不要為 config-edit 開新 IPC（它是 turn，重用 send/turn 路由）
- `applyConfigEdit`（明確變更，有 divider）≠ `setModel`/`setEffort`（orchestrator 每訊息的 silent pref-diff，無 divider）


## 64. Config 套用職責邊界：能塞給 SDK 就塞，不擴張權責（model / effort / permission 同一套）

**背景**：曾為修「Copilot 卡在外來 model id（`claude-opus-4.8` 漏進 `agentPrefs.copilot`）每回合報 not available」而在 provider 加自訂驗證（比對 `listModels()` 擋未知 id）。判定為**擴張 provider 職責**後撤回。延伸 #55「不要在 renderer 加 model validation」到 provider 端，並把 model/effort/permission 收斂成同一條原則。

**統一原則（判準是「SDK 有沒有 apply 的 func」，不是「誰擁有 namespace」）**：
- **SDK 有 imperative apply func → 直接塞給它**，SDK 自己就是 validator，成功就用、**失敗照實 emit error**。不自己前置驗證。
- **SDK 沒有（值只能透過下次 query 的 options 生效，如 Claude）→ 只記 closure、defer 到下次 query**，由 SDK 收到 option 時判定。不為了「當下就驗」而擴張權責。
- 不維護自家白名單前置拒絕 model——清單（`listModels()`）會落後 GitHub 實際支援（例：opus 4.8 已上線但 `listModels` 還沒列，前置擋會誤殺）。「卡在外來 id」靠 SDK 報錯 + 使用者改選（picker 只列合法值）復原。

**三個 knob × 兩 provider**：

| knob | Copilot（有 live-session func） | Claude（無，per-call options） |
|------|------|------|
| model | `session.setModel(model)` 直接塞 | 記 closure，下次 query `options.model` 由 SDK 驗 |
| effort | `session.setModel(model, {reasoningEffort})` 直接塞 | 同上 |
| permission | `session.rpc.mode.set({mode})` 直接塞 | 記 closure，下次 query `options.permissionMode` 由 SDK 驗 |

**翻譯 adapter ≠ 驗證**：
- app 對外詞彙（permission list）是**共用單一來源** `PERMISSION_MODES` / `PermissionModeId`（`agent-server/providers/types.ts`）；各 provider 用 `pickPermissionModes(subset)` 宣告自己支援的子集。
- app→SDK 的**翻譯表是各 provider 自己的**，不共用：Copilot `MODE_TO_SDK`（→ `interactive`/`autopilot`/`plan`）；Claude 不翻譯（app 詞彙 == SDK 詞彙，直接傳 + bypass DIY 特例）。抽成共用 helper 是假複用（每家 target 詞彙不同、Claude 還沒有）。
- 翻譯**翻不出來** = 沒有對應的 SDK 動作可做（無效值，或 Copilot 不支援的合法 app 模式如 `acceptEdits`）→ 照實 emit error、不採用。這是「無 SDK action」的誠實回報，不是發明驗證。**踩過的雷**：舊 code `if (sdkMode) { set }` 翻不出來時跳過 SDK 卻照樣 `currentPermissionMode = args` + 回報成功 + persist → silent 假成功。

**Renderer / Backend 分層（回應「picker 兩邊行為是否不同」— 不同只在 backend）**：
- **Renderer 對 provider 無感、單一路徑**：picker/status-bar/無參數 `/model` → `handleConfigEdit` → `agent:send{configEdit}`；手打 `/model X` → 普通 prompt。送給 claude/copilot 完全一樣，renderer 不分流。
- **差異只在 backend apply 收斂點**（本質差異，勿為對稱強行統一）：Claude → `applyConfigEdit`（#63，純 set+emit）；Copilot → `query()` 把 `QueryInput.configEdit` 路由進 `dispatchSlash`（`permissionMode`→`/permission`）。**漏路由會 fall through 成空 prompt → 沒卡片、接續上次對話**（曾經的 bug）。
- 兩邊 config-edit 成功都 emit `system` divider（共用 `formatConfigAck`，「applies on next query」對兩邊都成立）；Copilot 失敗 emit `error`。`/help`/`/clear`/`/context`/`/compact` 仍是 `fold_markdown`（slash 內容輸出，非狀態轉換）。

**不要改**：
- 不要在 `gatherCapabilities`/`setModel`/`dispatchSlash` 加「model 是否在 `listModels` 清單內」的前置拒絕 — 交給 SDK，錯誤照實回。
- 不要把 app→SDK 翻譯表抽成跨 provider 共用 helper（假複用）；共用的只有 app 詞彙 list（`PERMISSION_MODES`）。
- 不要把兩 provider 的 config-edit apply 抽成跨 provider 共用函式 — apply 語意本質不同，只共用 `formatConfigAck` 文案與 wire 形狀。
- 不要在 renderer 為 copilot/claude 分流 config-edit — 分層邊界在 backend。

**Related**：#55（slash routing + prefs flow）、#63（config-edit 收斂）、#62（model 顯示 intent-driven）、`agent-server/providers/{claude,copilot}/index.ts`、`agent-server/providers/types.ts`（`PERMISSION_MODES`）、`src/shared/config-ack.ts`
