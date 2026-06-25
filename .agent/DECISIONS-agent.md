# DECISIONS — Agent Provider

Agent provider (Claude / Copilot)、wire protocol、Agent UI 架構、message type 設計相關決策。

編號保持歷史穩定（缺號表示已淘汰、併入 CLAUDE.md Conventions 或併入其他 decision）。跨檔 cross-ref 用 `DECISIONS #N` 直接 grep。

---

## 31. Agent View：兩 provider 都用各自原生 SDK + bundled CLI

**決策**: Agent tab 直接呼叫 AI provider SDK（不是解析 terminal scrollback）：
- Claude → `@anthropic-ai/claude-agent-sdk`，spawn bundled `claude` binary
- Copilot → `@github/copilot-sdk`，spawn bundled `@github/copilot` CLI（SDK 是 JSON-RPC wrapper，CLI 才是實際執行體）

兩者都在 `agent-server` bundle 裡執行，透過 stdin/stdout JSON line protocol 跟 main process 通訊。Binary 透過 `electron-builder` 的 `files` + `asarUnpack` 打包進 app（per-platform：claude-agent-sdk-{darwin|linux|win32}-{arch}、copilot-{darwin|linux|win32}-{arch}）。**Windows build 額外 force-install `claude-agent-sdk-linux-x64`**（CI step，因為 WSL agent-server 跑在 Linux）；npm `os` 限制用 `--force --no-save` 繞過。

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

## 45. Copilot 依賴 CLI 自己的登入狀態，token 不經手；`gh` 為「有就用、沒有也行」的選用捷徑

**決策（現行 = 過渡版 dual-path）**: `CopilotClient` 啟動時：
- **有 `gh` 且已登入** → 跑 `gh auth token` 拿 token，當 `gitHubToken` 傳入（`useLoggedInUser:false`）。Copilot CLI 用這個 token、**不讀自己 keychain 的登入** → 不跳 macOS Keychain 提示（gh 把 token 存純文字檔、非 keychain）。
- **沒 `gh`** → fallback `useLoggedInUser: true`，吃 Copilot CLI 自己的 OAuth / device-flow 登入（macOS 上存 keychain，未簽章 build 可能跳提示）。

純決策 helper `buildCopilotAuthConfig(ghToken)`（`copilot/helpers.ts`，單測）+ 不 throw 的 `readGhToken()`（`copilot/index.ts`，gh 缺/未登入/空輸出一律回 undefined）。

**原因**:
- 跟 Claude 一致：不經手/不自存 token，依賴本機官方 CLI 的登入狀態（Decision #43）。
- **`gh` 是選用捷徑、不是硬依賴**：沒裝照樣能跑（走 useLoggedInUser）。裝了就用它繞過 keychain 提示——這是為了**未簽章 macOS build 的 UX**(見「過渡」段)。遠端執行時 `gh auth token` 在遠端跑、拿的是遠端自己的 gh，與 Copilot 同處，語意正確。

**不要改**:
- 不要把 `gh` 變成**硬依賴**（沒 gh 就 throw）— 它是 optional fallback，缺了要能走 useLoggedInUser。
- 不要自己存 token 到 userData — keychain ACL 是 per-binary 綁定，自存等於把 GitHub OAuth refresh 邏輯重做一遍（這是「方案 B / 自管 token」要付的代價，過渡版刻意不做）。

**過渡（為何 dual-path，2026-06）**: 未簽章 macOS app 開 Copilot tab 會跳 Keychain 提示（拔 gh 改 `useLoggedInUser:true` 後 copilot 改讀自己 keychain token 所致，commit `6d5c615`）。對一般 user 觀感差。**永久解未定**（A:code signing / B:Shelf 自管 token），先上這版「有 gh 就用舊 flow 繞過、沒 gh 才走現 flow」當過渡。

> 歷史：早期 `useLoggedInUser:false` + `gh auth token` + `gitHubToken`（繞 keychain，gh 為硬依賴）→ `6d5c615` 改 `useLoggedInUser:true` 拔 gh（引入 keychain 提示）→ 現過渡版改成「gh 選用、有就繞、沒有 fallback」。

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

**Stop 行為**: `stoppable` flag 是 provider-internal、不上 renderer（業界共識：stop 按鈕永遠在、能不能停由 provider 決定）。`/compact` 整個 SDK turn、`/clear` 的 dispose+rebuild 都用 `critical()` helper 包成 non-stoppable，stop() silently no-op（避免 SDK 卡在 half-compacted state）。

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
- Wire shape：`prompts[]`（N 題）+ per-prompt `multiSelect` / `options[]`；`inputType: 'text' | 'number' | 'integer'` 時 renderer render 自填欄（覆蓋 AskUserQuestion 隱含 Other）
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
- Decision #54 — Slash 內部 dispatch（slash_response type 廢除、改 emit fold_markdown）
- Decision #46 — Plan panel（從 message channel 攔截改成獨立 event channel）

---

## 61. Provider 格式解析失敗一定要 fail-loud（console.error log）

> 通則見 CLAUDE.md「禁止靜默吞錯 / 丟資料」;本條是 **provider wire-format 解析**的具體化（preview 字數、stderr 不走 wire、pure parser 不 log 等）。

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

## 69. 背景任務（background tasks）— task_event lane 解耦 busy-state + detached-loop

> ⚠️ **claude 的 detached-loop / foregroundDone / sendChainGate / identity-guard 機制已被 #72（streaming-input 持久 session）取代**。仍有效、未變的部分：`task_event` turnId-less lane、`normalizeTaskMessage` emission、server-turn 自動續寫的渲染原語（wire 對 renderer 不變）。下面「detached-loop」「identity-guard teardown」兩條只作歷史紀錄，現況讀 #72。

**問題**：模型把工作丟背景跑（Bash `run_in_background`、自動背景化）時，前景 turn 正常 idle，但 claude SDK 的 single-prompt generator **不在 `result` 結束** —— 它繼續吐背景任務訊息、且任務 settle 後**自動讓主 agent 續寫一段回覆**（Phase 0 實測：`result` 在前景結束就發，generator 到任務 settle（~29s 後）才結束）。兩個衍生 bug：(a) 後續訊息帶**已死的 turnId** → main 端 `event for unknown turn … dropping`；(b) claude 的 `query()` 等整個 generator 結束才 resolve，卡住 `sendChain` → 下一個前景 send 卡死（無限轉圈）。

**決策**：

- **routing 與 busy-state 解耦**：背景事件走新 wire 訊息 `task_event`（`OutgoingMessage` variant，payload = `@shared/types` 的 `TaskEvent` / `NormalizedTask` 渲染原語），**不帶 turnId、不碰 status**。`wrapSendForTurn` 豁免它（比照 lifecycle）；turn-dispatcher `feed()` 在 turnId 檢查**之前**攔截 → session-level `onTaskEvent` callback → `IPC.AGENT_BACKGROUND_TASKS` → renderer `applyTaskEvent`。**絕不**用 `backgroundTaskId` 當 turn id（turn 綁了 idle/busy 語意，會破壞 non-blocking 本意）。
- **detached-loop（claude）**：把整個 consume loop 包進 detached async（`void drain().catch(releaseSendChain)`），`query()` 回傳的 Promise 在**前景 `result`**（`origin.kind !== 'task-notification'`，這是 SDK 標記自動續寫 turn 的判別器）就 resolve `sendChainGate`，解開 sendChain；loop 在背景續跑到 generator 真正結束。**🚫 不可用 `break` 接手**：`for await` 的 `break` 會呼叫 iterator `.return()` 殺掉 SDK generator（連背景任務一起殺）。
- **identity-guard teardown**：query() 提早 resolve 後，後一個 turn 可能已接管 module-level `activeQuery`/`abortController`；finally 用 `if (activeQuery === myQuery)` 才清，否則會蓋掉新 turn（正是 `sendChain` 序列化原本要防的 race）。
- **emission（純函式）**：`normalizeTaskMessage`（`helpers.ts`，可單測）把 SDK `task_started/updated/progress/notification` system 訊息 → `NormalizedTask`；index.ts 只持 `backgroundTasks`/`taskOutputFiles`/`ambientTaskIds` 三 map + 在 loop 呼叫它。**前景結束發 `snapshot`(仍 running 的 task)、之後逐則發** —— 同步 Bash 的 task 在前景 `result` 前就 done，自然被排除，**不會誤報卡片**（World A 不確定同步 Bash 是否也發 task_started，此設計對兩種都正確）。
- **read_task_output**：completed task 的完整輸出讀 remote `output_file`，**在 agent-server（遠端）端讀**（`ServerBackend.readTaskOutput` RPC，requestId 配對），main/renderer **永不**碰遠端 fs（憑證不跨界）。

**SDK 事實（Phase 0 真機確認）**：`result` 不帶 `background_tasks[]`（故 snapshot 靠累積事件、非 result）；status `killed→stopped`、`paused→running`；`task_type` `local_bash→shell`；`task_started.skip_transcript===true` = ambient task（不出卡）；自動續寫 turn 的 `result` 帶 `origin.kind:'task-notification'`。

**不要改**：
- 不要把 `task_event` 加 turnId（會被當 unknown turn 丟）。
- 不要在 detached-loop 裡 `break` 出 for-await（殺 generator）。
- 不要靠 `result.background_tasks[]` 做 snapshot（claude 不帶）。
- 不要把 `backgroundTasks` 跟 plan/TODO 的 `tasks` map（TaskCreate/TaskList → `renderPlan`）搞混 —— 不同概念、不同面板。
- 不要讓 idle 在背景階段重發（只前景發一次，沿用 `idleEmitted` dedup）。

**copilot 對齊（已實作）**：copilot `query()` = `await session.sendAndWait()`，在前景 turn 邊界就 resolve → **不需要 detached-loop**（sendChain 不卡，與 claude 不同）。背景變動走 `session.on` 的 `session.background_tasks_changed`（空 payload ping）+ `system.notification`（agent/shell completed 等）→ debounced `rpc.tasks.list()` → 過濾 `executionMode==='background'` → `normalizeCopilotTask`（純函式，`copilot/helpers.ts`）→ emit `task_event` kind `snapshot`。**`currentSend` 永不 null**（line 944 設、不清）→ 任務在 turn 之間 settle 也能發；且 `task_event` turnId-exempt → 路由正確（claude 那個 unknown-turn bug 在 copilot 被這兩點自然化解）。`readTaskOutput`：shell 讀 `logPath`（遠端讀檔）、agent 回 `result`/`latestResponse`。status 映射 `idle→running`、`cancelled→stopped`。**⚠️ 未經真機驗證**：沒有 copilot session 可測，emission 從 SDK `.d.ts` 寫 + 純 mapper 單測；live 行為（event 名、`rpc.tasks.list()` 回傳 shape）待真跑一次確認。

**未做（future enhancement，低優先，trigger 未到）**：
- ~~**stop-task**（從面板中止背景任務）~~ ✅ 已做（commit `020e1d4`，#72 Architecture B 已就位）：`Query.stopTask(taskId)` 串全鏈。面板 UI 後續整併成單顆「刪除」（stop+等確認+tombstone），詳見 #74。
- **server-turn 工具授權**：背景任務 settle 後 auto-resume 的 prose 若呼叫工具，會卡背景 drain（`canUseTool` 走 stale module-level send）。pre-existing 限制，低價值 + 踩 currentSend race，待真要時再正解。
- **copilot 真機 turn 驗證**：見上方「⚠️ 未經真機驗證」。

**Related**：`agent-server/providers/claude/index.ts`（detached-loop）、`helpers.ts`（`normalizeTaskMessage`）、`agent-server/providers/fake/index.ts`（`task:`/`taskdone:` E2E scenarios）、`src/main/agent/turn-dispatcher.ts`（`onTaskEvent`）、`src/renderer/components/agent/BackgroundTasksPanel.tsx`、`src/renderer/agentTabStore.ts`（`applyTaskEvent`）、#59（事件/Store 分層）、#60（渲染原語）。

---

## 70. `~/.shelf/` 部署 taxonomy + cp-to-remote 投影模型（client/server m:n）

> **狀態**：部分已實作（agent-server / context），部分為規劃中的**規則**（per-app 投影、TTL 清理）。本條是「`~/.shelf/` 要放什麼、怎麼 cp 到 remote」的**長期參照規則**，新增任何 `~/.shelf/` 內容前先過這條。

**心智模型（既有架構，非比喻）**：app = **client**（本機唯一，持有使用者真相 = `<userData>`）；`~/.shelf/` = **每台機器上的 server data**（agent-server 跑哪、`~/.shelf` 就在哪——local 在本機、SSH/Docker/WSL 在遠端）。`remote.ts` 對**每個 connection** spawn 一個 agent-server → **1 client : N servers**；且同一台 server 可被多個 client 連 → 實為 **m:n**。`~/.shelf/` 內容**一律用 `os.homedir()` 定址**（agent-server 拿不到 Electron userData）。

**Taxonomy（決定新東西放哪的唯一準則）= 「跨 app 該不該共享」**：

| identity | 跨 app | 路徑 | 例 |
|---|---|---|---|
| **version**（內容 = 位元組，同版相同）| **該共享**（dedup 大 payload）| `~/.shelf/agent-server/<version>/` | bundle / node / 215MB CLI binary（#32）|
| **app**（內容因 app 而異）| **絕不共享**（會互蓋）| `~/.shelf/apps/<appId>/…` | skills 投影（規劃中）、未來 per-app 投影物 |
| server 原生、已被自身 key 隔離 | 不共享 | 暫留原位（可選歸 `apps/`）| agent-context `by sessionId`（#35/#38）|

- **`<appId>` = `appInstanceId`**：存 `<userData>` 的 UUID、generate-once（同 sessionId 模式）。dev/test/prod 因 userData 隔離而各自獨立 → 共享 server 上不互蓋。**不要**改用 machine-id / `~/.shelf/client-id`（dev/prod 會共用 id → 互蓋）。

**cp-to-remote 投影模型（source → server data 的統一規則）**：
- **source of truth 永遠在 client `<userData>/…`**（UI 編輯、唯一一份）；server 端是**投影副本**（衍生、可丟、可重建）。
- **消費路徑對 local/remote 一致** = `os.homedir()/.shelf/apps/<appId>/…`；agent-server **零 local/remote 分支**，main 只送 `appId`。**local = 本機 fs cp、remote = scp/docker cp/wsl**（同一機制、不同 transport，複用 `deploySelfContained` 管線）。
- **增量 gate**：頻繁變動的使用者內容（如 skills）用 **content-hash sentinel**（client hash != 遠端 `.synced` 才 re-sync）；不可變的版本化 payload（bundle）用版本目錄 + `.deployed` sentinel（#32）。
- **mirror 語意**：投影 = **整包替換**（砍掉重推）→ 自然涵蓋刪除 / rename。投影物可丟，免 migration。
- **Docker 短暫性**：container 重建即丟（同 #38）→ 下次連線 sentinel 不在 → 全量推，self-healing。

**清理一律走 heartbeat-lease sweep，不 eager 互刪**（✅ 已實作 `agent-server/cleanup.ts`，見 #71）：
- ⚠️ **既有坑（✅ 已修）**：舊 `remote.ts` agent-server 版本清理 = 「刪掉除當前版本外所有版本」，**隱含「一台 server 一個 app」**。m:n 反例：共享 server 上 app A(v2) 部署會刪掉 app B(v1) 在用的 v1 → B 下次 spawn 重部署 v1 又刪 v2 → **互刪 + 反覆重傳 215MB（thrash）**。
- **正解 = 改清理策略**（非改 key）：live agent-server 每拍心跳 touch `.heartbeat`（version dir + `apps/<appId>` dir）；agent-server **啟動時** `runCleanupSweep` 掃自己機器，回收非 floor、`.heartbeat` 停 >1 天的 version、及無 fresh lease 的 appId。同時保住 **dedup + m:n 安全 + 自清**。詳細參數/觸發/race 修正見 #71。

**不要改**：
- 不要把 agent-server 改成 appId-keyed —— 殺掉大 binary 的跨 app dedup，且 version 仍得內嵌、沒真的消失（兩個 key 都還在）。
- 不要把 per-app 投影物（skills 等）改成 version-keyed —— 內容因 app 而異，會 m:n 互蓋。
- 不要讓 client 直接讀寫遠端 fs —— 投影一律由 client→server 走既有 deploy transport 推（憑證不跨界）；讀遠端僅限自己 deploy 的小 sentinel。
- 不要為 local 開特例直接指 `<userData>` —— 統一投影到 `~/.shelf/apps/<appId>` 才能 local/remote 零分支（agent-server 同一份 code 只能 `os.homedir()` 自解）。

**Related**：#32（agent-server bundle deploy + `.deployed`）、#35/#38（context 持久化 / `os.homedir()` 定址）、#43（provider 差異封裝）、**#71（App 層 skills + heartbeat：此規則的第一個 per-app 投影實例，已實作）**、`src/main/agent/{remote.ts,deploy-layout.ts}`、`agent-server/{cleanup,context-store}.ts`。

---

## 71. App 層 Agent Skills（開放標準 + 投影）＋ agent-server heartbeat

**背景**：使用者要 **app 層、跨 project、Claude/Copilot 都能用**的 skill。Agent Skills 是開放標準（`SKILL.md`），兩家原生吃，但**沒有共用的自訂目錄機制**：Claude SDK 不支援 env/settings 自訂路徑（只認寫死 `~/.claude/skills`），Copilot 走 `skillDirectories`。

**決策（skills）**：
- **Source of truth = `<userData>/skills/`**（Shelf UI 編輯，`skills-store.ts` CRUD）。layout 即 Claude **plugin root**：`.claude-plugin/plugin.json`（`{name:"shelf-skills"}`）+ `skills/<name>/SKILL.md`。SKILL.md 是使用者 raw md（opaque，store 只 parse name/description）；**frontmatter `name` = identity**，存檔 rename folder（kebab 驗證 + 撞名檢查）。
- **消費端統一走「投影 + 兩家各自指」**（#70 的第一個實例）：投影到 `os.homedir()/.shelf/apps/<appId>/skills`（local fs cp = `skills-projection.ts`；remote scp/docker cp/wsl = `remote.ts syncSkillsToRemote`，content-hash `.synced` gate）。Claude `options.plugins=[{type:'local',path:<root>}]`（自訂目錄的唯一官方解法，skill 顯示為 `shelf-skills:<name>`）；Copilot `createSession({skillDirectories:[<root>/skills]})`（session-cached，新 skill 可能需 reopen/`/skills reload`）。`providers/shared.ts resolveSkillsPluginRoot` 路徑存在才指。**renderer 對此無感**（守 #43）。**✅ Claude 真機驗證通過（2026-06，`scripts/verify-skill-loading.mjs`）**：SDK `system/init` 回 `plugins:[{name:'shelf-skills',…}]` + `skills` 含 `shelf-skills:<name>`，模型主動觸發使用。**⚠️ 載入時機因 #72（Architecture B）從 per-query → per-session**：plugins 在持久 query 建立時載入一次。**（更新：#80 已接 live hot-reload —— skill 改完自動 reload 進 live session、免重連、下個 turn 生效；下方「要重開 tab/重連」已不再成立。）**驗證注意：手建測試投影 dir 要 touch `apps/<appId>/.heartbeat`，否則被 agent-server 啟動 sweep 掃掉（真實投影流程會 touch）。
- **appId = `app-instance-id.ts` 的 userData UUID**（#70 隔離 key）。

**決策（heartbeat，獨立基礎建設，skills 搭便車）**：app↔agent-server 的 `ping`(帶 `seq`)/`pong`(echo `seq`) 一拍**三用**：
1. **連線健康 UX**：client 單邊時鐘算 RTT（server 時鐘不進比較）→ `ConnectionHealthTracker` 5 狀態 → Sidebar project `status-dot` 5 色 + 惡化 flash。
2. **cleanup lease**：agent-server 收到 ping 即 touch version dir + `apps/<appId>` 的 `.heartbeat`。
3. **dead 偵測**（連續漏拍）—— 目前只回報 UI，**未做** auto-kill（避免可復原 blip 殺 session）。
- 時間：心跳 1m、reclaim TTL 1d（`SHELF_HEARTBEAT_INTERVAL_MS` 可覆寫給 E2E）。

**踩過的雷（heartbeat-lease sweep × 投影 的順序）**：agent-server **啟動時** sweep 跑在第一拍心跳**之前**，且當下 `lastAppId` 未知 → 剛投影/同步、還沒 `.heartbeat` 的 `apps/<appId>` 被當 orphan 刪掉 → skill 瞬間消失。**修法：投影/sync 時就 touch `apps/<appId>/.heartbeat`**（投影本身是 liveness 訊號）。docker E2E（`agent-deploy-skills.spec.ts`）抓到此 bug。（version dir 無此問題：有 fresh `.deployed` fallback + current/floor 保護。）

**不要改**：
- 不要為 Claude 改用 `settingSources`/塞 `~/.claude/skills` —— `plugins` 是官方自訂目錄解法且不汙染使用者目錄。
- 不要在 renderer 分流 provider（Claude 帶 namespace、Copilot 不帶）或感知 skill 載入細節。
- 投影/sync 完**必須** touch appId `.heartbeat`，否則被啟動 sweep 回收。
- heartbeat RTT 不可跨兩端時鐘比較（無時間校正）。
- 不要把 `skills/skills` 兩層「化簡」成單層 —— 內層 `skills/` 是 Claude plugin 格式強制（`<root>/skills/<name>`），外層刻意 = source 即 plugin root，換取投影**零路徑改寫**（直接 `cpSync`，Claude 指 root、Copilot 指 `root/skills`）。化簡頂多改外層名（純美觀，使用者看不到），代價是投影改成動態合成 plugin root + 改寫 relpath，連動 hash gate / remote sync 一起複雜化。

**待辦（未做）**：~~真機驗 Claude 載入 skills~~ ✅ 已驗（見上）；**Copilot 載入 skills 仍待真機驗**（無 session 可測）；user-invoke 一鍵觸發（`/<name>`，兩家不對稱）；degraded 健康狀態的 E2E（需 fake provider 支援延遲/丟 pong）；~~健康顏色 per-theme token 化~~ ✅ 已做（commit `2ed5319`：project status-dot 用 `--status-healthy/slow/unstable/dead`，**刻意與 agent 的 `--agent-*` severity 分離**為獨立 palette）。

**Related**：#70（taxonomy + cp-to-remote 投影）、#43（provider 封裝）、#47（status severity 抽象）、`src/main/{skills-store,skills-projection,app-instance-id}.ts`、`src/main/agent/{remote,connection-health}.ts`、`agent-server/{index,cleanup}.ts`、`agent-server/providers/{shared,claude/index,copilot/index}.ts`、`src/renderer/components/{SkillsView,Sidebar}.tsx`。

## 72. Claude provider 改用 streaming-input 持久 session（取代 #69 detached-loop）

**問題（症狀）**：同一對話流程，送出後**有時整輪沒回應，下一輪才正常**。根因確認（讀碼 + 真機 smoke）：#69 的 detached-loop 讓 claude `query()` 在前景 `result` 就提早 resolve、解開 agent-server `sendChain`，**但該 turn 的 SDK query（`myQuery`）還活著在背景 drain**。下一個 send 進來時 claude `query()` 無 guard 直接再開**第二個 `sdkQuery`、resume 同一條 session**（`activeQuery = sdkQuery(...)`）→ 兩個 driver 並發打同一 session → 第二輪輸出被吞，直到第一輪背景 settle（=「下一輪」）。**copilot 無此 bug**（`sendAndWait` 對已持久化 session 逐 turn resolve、循序）。

**SDK 查證（`@anthropic-ai/claude-agent-sdk@0.3.159`，真機 spike）**：streaming-input 是一級公民 —— `query({prompt: AsyncIterable<SDKUserMessage>})` 一條持久 query；control methods `interrupt()`/`setModel()`/`setPermissionMode()`/`setMaxThinkingTokens()`/`stopTask()`/`close()`（僅 streaming 模式）。**result 無任何欄位指回來源 user message** → turn 對應只能靠順序。

**決策**：一個 backend instance（= 一個 tab）持有**一條持久 streaming-input `sdkQuery`** + **單一 consumer loop**。每次 `query()` 把 prompt 當 `SDKUserMessage` push 進去、await「這個 turn 的前景 result」就 resolve（`sendChain` 不變、本來就對逐-turn-resolve 正確序列化 → **不可能再有第二個並發 query**）。

- **turn 對應（純函式 `claude/turn-router.ts`，9 單測）**：result 無 backref，靠順序 + 一個 wire 信號。turn 嚴格序列、各以 `system/init` 開、以一個 `result` 收。狀態機極簡：`init` → **有待處理 user push（`pendingPush>0`）就是前景、否則是 SDK auto-resume → server**；任何 `result` → **收掉「當前 active 的 turn」**（不靠 origin 配對 —— 同時只有一個 active turn，故 init 萬一猜錯也不會 hang，只會 cosmetic）；`task_*` → task lane（**不影響 turn 對應**）。
  - **🩸 踩過的雷（真機卡死，已修 commit `5c075f1`）**：初版用「`task_notification` arm 一個 counter、下個 `init` 消耗」判 auto-resume。但**背景任務 settle 後模型不一定 auto-resume**（沒講話就沒那個 init）→ counter drift 正值 → **偷走下一個真前景 turn 的 init** → 該 turn 無 active lane → result 被 ignore → `query()` 永遠 hang（spinner 卡、`interrupt()` 無效因 SDK turn 早結束）→ 送下一則才慢慢 re-sync。**正是使用者回報的「stream 卡住、ESC 停不了、下一輪才正常」**。smoke 漏掉是因為它的背景任務每次都 auto-resume。改用 `pendingPush`-presence 判別即 drift-proof（deterministic 單測 `task_notification WITHOUT auto-resume` 守住）。
- **per-turn 狀態進 FIFO entry**：`send`/idle-deduped `turnSend`/`blockMsgIds`/`pendingCompactMsgId`/`resolve` 各 turn 自持；consumer 路由到 `activeForeground`/`activeServer`。**`lastTurnSend` 取 RAW `send`（非 turnSend）** —— server turn / capabilities / task_event 不可被前景的 idle-dedup 吞掉（踩過：取成 turnSend 會吃掉 server idle）。
- **控制方法**：`setModel`/`setPermissionMode` → SDK control method（mid-session 即時，免 re-resume）；**effort 無 control method → close 舊 query + `resume=lastSessionId` 重建**（罕見、最 robust）；`dispose()` → `close()`。
- **ESC 最高優先（commit `21b4b74`）**：`stop()` **先**同步 `cancelActiveTurns()`（resolve 在途 turn 的 `query()` + 發 idle + reset router）**再** best-effort `interrupt()`。**ESC 永不依賴 `interrupt()` 生效** —— interrupt 可能慢或 no-op（SDK turn 早結束、卡在路由），故必須本地強制收尾保證 UI + sendChain 立刻脫困。單測：interrupt 為 no-op 時 stop 仍 resolve query + 發剛好一個 idle。

**驗證**：純 router 9 單測 + 既有 background-tasks 整合測（mock SDK，序列改為真實 `task_notification → init → assistant → result`）+ **真機端到端 smoke**（`scripts/smoke-streaming-input.mjs` 驅動打包 agent-server + 真 claude）：跨 turn 同 session、**背景任務未 settle 時送第二則正常回覆（原始 bug 修復）**、auto-resume server turn。

**不要改**：
- 不要在 claude 再開 per-turn 新 `sdkQuery`（並發打同 session = 原始 bug）。
- `lastTurnSend` 必須是 RAW send（server idle / capabilities 不可被前景 idle-dedup 吞）。
- 對 renderer 的 wire 不變（仍走 #69 的 task_event / server-turn 渲染原語）。
- copilot 不動（本來就持久 session）。

**待辦（未做，低優先）**：cosmetic race —— 使用者**正好在 auto-resume 視窗內**送新訊息時，auto-resume 的 init 會 consume 該 pending push（把 auto-resume prose 當成新訊息的回覆、新訊息的真正回覆改以 server turn 渲染），**不會 hang**、兩 turn 都正常收尾，只是視覺錯位（罕見）；~~`/clear`·`/compact` 在 streaming 模式真機驗~~ ✅ 已驗（`scripts/smoke-slash.mjs`）：`/clear` 確實 reset context（session 存活、後續 turn 正常）、`/compact` 正常 idle 不 wedge。**小瑕疵（pre-existing，非 B）**：對話太短「沒東西可壓縮」時 SDK 不發 `compact_result`，卡片落到 fallback「Compaction did not complete」（誤導，其實是 no-op）—— 邊角、低價值，暫不修；持久 query 崩潰恢復（resume 重建 + 收尾在途 turn，目前 `teardownTurns` 發 idle）；`backgroundTasks()` 主動背景化（SDK 有，未接 UI）。

**stop-task ✅ 已做（commit `020e1d4`）**：`Query.stopTask(taskId)` 全鏈接線 —— `ServerBackend.stopTask`(claude→`session.query.stopTask`)、agent-server `stop_task` dispatch(fire-and-forget)、`AgentBackend.stopTask`→remote sendLine、IPC `AGENT_STOP_TASK`+preload、`BackgroundTasksPanel` running 任務的 ■ 鈕；回來的 `task_notification('stopped')` 走既有 task_event lane → 卡片顯示 ⊘。**驗證 ✅ 真機端到端通過**（`scripts/smoke-stoptask.mjs`）：開背景任務 → `stop_task` → task_event 回 `status:'stopped'`、卡片 ⊘;另有 provider→SDK 接線確定性單測。**更正一個先前誤判**：曾以為「SDK `run_in_background` 不發 `task_started`、面板看不到任務」—— 那是 **smoke 檢查太早**(在 task_event 抵達前就查)的假象。raw SDK 實證(`scripts/spike-bg-notify.ts`)`run_in_background:true` **穩定發 `task_started`**,且 `task_id` 與 tool-result「running in background with ID」相同;`task_started` 可能落在前景 idle **之後**幾 ms（routeTask 那時走「個別 emit」），消費端要**等** task_event 而非同步查。

**agent-server 同類「缺 idle → renderer wedge」修（真機抓到，commit `b842e07` + `388b91b`）**：renderer 在 send 當下即切 streaming，故 **agent-server 任何 send 都必須以 idle 收尾**，否則 spinner + queue-flush latch 永久卡死（= 使用者回報「送圖不送字整個卡住」）。`handleSend` 的 guard 原本 image-only（空 prompt）回 `Missing prompt or cwd` 後**只 return、不發 idle**；ESC 也救不了（provider 無 active turn）。修：(1) 有 `images` 就算空 prompt 也放行進 SDK；(2) **每個早退路徑（prompt/cwd guard、getBackend 失敗、`sendChain.catch`）一律補發 idle**。屬 agent-server orchestration、非 claude-only（pre-existing，被這次真機測逼出來）。

**renderer ESC UX（已決定 2026-06，維持現況不改）**：觸發維持**雙擊**（1.5s 內兩次，防誤觸誤殺一輪）；捕捉維持**綁輸入框焦點**（零誤觸風險）；`/compact` 期間維持 `stoppable=false` **不可中斷**（避免半壓縮壞狀態，通常幾秒）。ESC 的實質保證在 provider 端的 force-close（見上），renderer 行為不動。

**Related**：#69（被取代的 detached-loop；task_event/server-turn 渲染仍沿用）、#43（provider 封裝）、`agent-server/providers/claude/{index,turn-router,turn-router.test}.ts`、`agent-server/providers/claude/background-tasks.test.ts`、`agent-server/index.ts`（handleSend idle 保證）、`scripts/{spike-streaming-input,smoke-streaming-input,smoke-image-only}.*`。

## 73. 跨睡眠的連線存活：不做 client auto-kill；ssh-only agent-server idle-shutdown watchdog

**問題**：連線健康（#71）判 `dead`（連續漏拍 ≥180s）後該不該動手清掉 session？兩個方向 —— client 端 auto-kill（殺 session）、server 端 self-exit（agent-server 自殺）。

**真機數據（一整夜 ACK log，本機連線）**：筆電睡眠每 ~16–17min 一個 dark-wake 循環,整夜 ~30 次。每次:清醒時 `N/N acked`、RTT 1–23ms(穩);睡眠 → `healthy→dead lastAckAgo≈1000s`(時鐘跳、timer 沒跑造成的假掉拍)→ **醒來 ~4ms 內 `dead→healthy`**、RTT 正常。**連線從未真的故障** —— 每個 dead 都是睡眠假象。

**決策**：

- **🚫 不做 client auto-kill on dead**：上面數據是最強反證 —— 「dead 就殺」會在筆電每次睡眠/dark-wake 殺掉一個完全健康的 session（一晚幾十次）。且 **local/docker/wsl 與 client 共命**（同機/同機 VM，一起 suspend），dead 期間 server 也睡著、根本沒資源可回收。維持「只回報 UI（status dot 變色）、不殺」。
- **✅ ssh-only agent-server idle-shutdown watchdog**：判準是 **host 與 client 是否共命**，不是 local-vs-remote：
  - local / docker(本機 VM) / wsl(本機 VM) → **共命**，一起睡 → keep alive 免費,**不需要**(就算 arm,suspend 時 timer 凍結也不會 fire)。
  - **ssh** → 獨立遠端主機,筆電睡時**仍在跑、空轉吃資源** → 該自我了結。
  - 機制:watchdog 住 agent-server(`--idle-shutdown-min=N`),收 `ping` reset、逾時 → `dispose backends + process.exit`。**只有 ssh spawn path 帶這個 arg**(remote.ts),其他 transport 天然豁免。
  - config:`SSHConnection.idleShutdownMinutes?`(per-remote;**單位分鐘**,ms 對使用者太細)。**`0` / 明確關 = always keep alive;ssh absent → 預設 5min**(remote.ts 套)。N 在 agent-server 以 float 解析(測試可用 sub-minute)。
  - 門檻取捨:5min = 5× ping 間隔 → 清醒使用不誤觸發(連續 5min 沒 ping 那也真的斷了);但 5min < dark-wake gap(~16min)→ **ssh 睡下去 ~5min 後遠端就自殺**(= 預期:ssh 不為睡眠 client 守著)。**代價:遠端在跑的背景任務會死**;醒來 respawn + resume(`lastSessionId`)。要保留遠端就把該 remote 設 `idleShutdownMinutes: 0`。

**ACK log(診斷基建,commit `aee14b0`/`af2d07b`/`71f6bf3`)**:`remote.ts` 心跳改 lean log —— 滾動視窗每 `SHELF_HEARTBEAT_SUMMARY_MS`(預設 60min)一筆 `heartbeat ok: N/N acked …`,health 狀態變化即時記(`→dead`/`→healthy` 帶 rtt/lastAckAgo)。**啟動 artifact 修**:`lastHealthState` 初始設 `'healthy'`(配 tracker grace period)避免第一拍假的 `init→healthy` + 半開視窗 flush 成 `0/1 no acks`;首次 ack 記一筆 `heartbeat established rtt=Xms`。

**驗證**:`scripts/smoke-watchdog.mjs`(真機 spawn bundle)三情境:無 ping→3s 自殺、定期 ping→存活、無 arg→停用。

**不要改**：
- 不要加 client auto-kill on dead（睡眠假 dead,一晚殺幾十次健康 session）。
- 不要對 local/docker/wsl 套 watchdog（共命、無意義;只 ssh）。
- watchdog 門檻不要設成「< dark-wake gap 但你又想保留睡眠中的遠端背景任務」—— 想保留就 `idleShutdownMinutes: 0`。

**Related**：#71（heartbeat / connection-health）、`src/shared/types.ts`（`SSHConnection.idleShutdownMinutes`）、`src/main/agent/remote.ts`（ssh spawn arg + ACK log）、`agent-server/index.ts`（watchdog）、`scripts/smoke-watchdog.mjs`。

## 74. 背景任務卡片：單顆「刪除」走到 SDK + 等確認才隱藏 + tombstone 防 resurrection

**問題**：`BackgroundTasksPanel` 原本 running 任務有兩顆鈕 —— `■` 停止(`stopTask` 真的送到 SDK)、`×` 移除(純 `removeBackgroundTask`,**只清畫面、沒碰 provider/SDK**)。語意重疊又誤導:使用者以為 `×` 是「刪掉這個任務」,其實任務還在遠端跑。且 `×` 對 running 任務有 **resurrection bug**:`applyTaskEvent` 是 by-id upsert,local 移除後稍晚的 `stopped` echo / turn-boundary snapshot 會把卡片原地長回來。

**決策**：合併成**單顆 `×` 刪除**,語意依任務狀態分流:
- **已結束**(completed/failed/stopped):沒有東西要停 → 直接 `removeBackgroundTask`(local)。
- **running**:一定送 `stopTask` 到 SDK(`AGENT_STOP_TASK` → `ServerBackend.stopTask` → `Query.stopTask`);卡片標 `stopping…` **保留顯示,等 SDK 回 terminal `task_event` 才自動移除**(panel 內 `stopping` set + `useEffect` 偵測該 id 變 `done` → 移除)。加 **5s fallback timeout** 防漏送(SDK notification 不保證送達,見 claude-code #20754)卡住。
  - 取捨:選「等確認才消失」而非「樂觀立即消失」—— 直接對應使用者「真的去移除」的要求,且不會出現「畫面沒了但遠端還在跑」的隱形 orphan。代價是多一個 stopping 過場 + timeout。

**resurrection 修法(store 端)**:`removeBackgroundTask` 把 id 記進 **`dismissedTaskIds` tombstone**;`applyTaskEvent` 對 tombstoned id 不再 upsert。`/clear`(session wipe)一併重置 tombstone(id 可重用時能重新出現)。這同時修掉舊 `×` 對 running 任務的 resurrection。

**為何不加「list/get all background tasks」**:claude-agent-sdk(`0.3.159`)**沒有** host 端列舉 API —— `Query` 只有 `stopTask(taskId)`,任務清單得自己從 `task_notification` 事件流累積(本 panel 即如此)。社群已提 feature request 但**官方 closed as not planned**(anthropics/claude-code #29011)。故維持事件流自組清單,不追求 pull API。

**後續(running vs done 的視覺/語意區隔)**:`×`「單顆鈕、狀態分流」的後端行為不變,但**外觀依狀態分化**,因為 background task(真的在跑的 process)與 plan/todo(唯讀 checklist,#69 的 `tasks` map → PlanPanel)使用情境不同:**done** = 淡 `×`(無破壞性,直接 dismiss);**running** = 一顆 danger「Stop」鈕 + spinner 狀態圖示(取代靜態 glyph,一眼看出「活著」)+ **兩段式確認**(第一下 arm 成「Stop?」、`STOP_ARM_REVERT_MS`=3s 內第二下才真殺),避免誤點殺掉 live work。決策邏輯抽成純函式 `decideTaskButton(done, stopping, armed)` 可單測。

**驗證**:store tombstone 防復活 + `/clear` 重置 + `decideTaskButton` 狀態(單元,`agentTabStore.test.ts` / `BackgroundTasksPanel.test.ts`);running 兩段式 Stop → stopTask 經 SDK → 確認後移除(E2E,`agent-background-tasks.spec.ts`,fake backend `stopTask` emit `stopped`)。

**Related**:#69(task_event lane)、#72(stop-task 全鏈)、`src/renderer/components/agent/BackgroundTasksPanel.tsx`、`src/renderer/agentTabStore.ts`(`dismissedTaskIds` / `applyTaskEvent` / `removeBackgroundTask`)、`agent-server/providers/fake/index.ts`(`stopTask`)。

## 75. 背景任務在前景 turn 內完成會被吞掉（snapshot 只挑 still-running）

**症狀**:「開 5 個 `run_in_background`,面板只剩 1 張卡」。

**逐層排除**(真機 probe `scripts/spike-bg-notify.ts` 一次開 5 個背景 bash):
- **SDK 乾淨** —— 5 個 `task_started`、5 個**各自不同**的 `task_id`,一對一對應 `tool_use_id`,完成通知 5 個全到。**沒有 task_id reuse / collision**(網路上也查無此類報告;最接近的 #20754 是 parallel 通知漏送,且其 id 仍各異)。
- 故 collapse 必在**我們自己的對接**。

**根因**(`claude/index.ts`):
1. `routeTask`:前景 turn 進行中(`activeForeground` 非空)的 task 事件**不逐一 emit**,只寫進 `backgroundTasks` Map。
2. `closeForegroundTurn`:turn 收尾只 `snapshot = backgroundTasks.filter(t => !t.done)`。
3. **致命組合**:某背景任務**在前景 result 之前就完成** → Map 裡標 `done` → 被 `!t.done` 濾掉,而它先前又沒被逐一 emit → **整張卡從未送達 renderer**。跑得快的幾個被吞,只剩最慢、仍 running 的進得了 snapshot → 看起來「5 變 1」。

**修正**:`routeTask` 改成**即時送**(`task_event` 一到就 emit,連前景 turn 內也是),不再累積到 turn 收尾。`task_event` 是 turnId-less、落在獨立的 BackgroundTasksPanel lane,**不會跟 turn 內容流交錯**,所以即時送是安全的;`closeForegroundTurn` 仍發一個 still-running 的 snapshot 作對帳(idempotent upsert)。這一次同時解掉兩件事:(a) turn 內完成的任務以 `done` 即時送達、不再被 running-only snapshot 濾掉(原 drop bug);(b) 面板**隨任務 start/settle 即時更新**,不再「整輪結束才一口氣冒出所有卡」。

> **為何即時送安全(關鍵前提,已真機驗證)**:`scripts/spike-sync-vs-bg.ts` 證實 **同步(前景、`run_in_background=false`)Bash 不發 `system/task_started`**,只有真正背景化的任務才發。所以即時送**永遠不會**幫前景 shell 呼叫冒假卡 —— #69 當初「累積+只 snapshot running」正是為了防這個(當時 World A 不確定同步 Bash 會不會發 task_started),前提既已推翻,即時送取而代之。
>
> 中間一版用 `pendingForegroundTaskEvents` 累積、turn 收尾 flush —— 已被即時送取代(更簡單、且修了 UX)。

**驗證**:`background-tasks.test.ts` —— ①5 個 task_started 同 turn → snapshot 帶 5 個 distinct(排除 collapse);②bg1 turn 內完成 + bg2 running → renderer 收到**兩者**(bg1 completed、bg2 running),先前紅燈、修後綠。

**Related**:#69(task_event lane / detached-loop)、#74(面板單顆刪除)、`scripts/spike-bg-notify.ts`(多任務 probe)。

**附帶觀察(同類但不同路徑)**:前景 tool 結果(`processMessage → emitClaudeToolUse`)是**直接 emit、無 accumulate/suppress**,跟背景 lane 獨立。唯一耦合點是 **turn-router**:非 init/result/task 的內容訊息若在 `active===null` 時到達(init/result 被 mis-attribute,或 SDK 在 `result` 後又補發 assistant/tool 內容),會被 `routeMessage` 判到 `lane:'ignore'` **靜默丟棄** —— 這正是「看不到 tool use result」的潛在 silent-drop 路徑。已在 `handleSdkMessage` 的 `ignore` 分支加診斷 log(`[claude] router dropped content with no active turn`,帶 `type/subtype/pendingPush/active`),正常情況永不觸發;一旦印出即坐實線上有前景內容被丟。修不修行為待真機 log 確認後再定。

**Silent-drop 稽核(agent 管線)**:既然連踩兩個靜默 bug,掃了一遍「會吞資料卻不留痕」的點。結論:agent-server 的 `catch` 大多已 log 或 emit error(最終 best-effort 清理/關閉的空 catch 可接受)。真正缺 log 的是 routing/dispatch 的 drop-guard,已逐一補上 `console.error`/`log.info`/`console.warn`:
- `claude/index.ts` `handleSdkMessage` 的 `lane:'ignore'` —— content 訊息無 active turn 被丟。
- `claude/index.ts` `routeTask` —— task_ 無 `task_id`、或未知 task_ subtype 無法 normalize。
- `turn-dispatcher.ts` —— `parseRemoteMessage` 回 null(未知 wire type / msgType / 畸形 payload)的 turn 內容被丟。
- `agentTabSubscriptions.ts` `agent:onMessage` —— tab 未初始化、或 `buildAgentMsg` 對未知 msgType 回 null 的訊息被丟(renderer 端「content 不顯示」)。
這些正常情況永不觸發;一旦出現在 agent-server stderr / devtools console,即坐實某類 wire shape 沒被處理。 **copilot 同查**:`session.on` 的 switch 缺 `default` → 未知 SDK event type 靜默丟,補了 default 診斷。真機一跑發現 copilot 對**大量 lifecycle 事件**都 fire(`session.idle`/`assistant.turn_start|end`/`user.message`/`hook.*`/`permission.requested|completed`/`tool.execution_partial_result`…),全是良性 no-op,但 agent-server stderr 在 main 端記成 `[ERROR]` → 變洗版假錯誤。改成 **`KNOWN_IGNORED_COPILOT_EVENTS` 明確 allow-list(知情忽略),default 只對真正未知的新 type 警告一次**。其餘 catch 多已 log。copilot 的背景任務走全量 `snapshot` 重讀,故無 claude 那個「快任務 drop」問題。**已知 by-design 的略過**(routeServer 只處理 auto-resume turn 的 assistant、ambient task 隱藏)維持靜默,屬刻意行為。

## 76. Auto-resume(背景任務後自動續寫)期間顯示 busy,而非凍結在 idle

**問題**:背景任務 settle 後,SDK auto-resume 讓 agent 自動續寫一段回覆(server turn)。但前景 turn 早已在自己的 `result` 發過 idle,而 **server turn 完全沒發 `streaming`**(只 `turn_started` + 結尾 `idle`),且 main 端 server-turn drain **無條件跳過所有 status**(#69:怕蓋掉並行前景 turn 的 spinner)。結果:auto-resume 一路**串流 prose 卻顯示 idle** → 使用者看到「idle 卻又冒出回應」,以為狀態壞了。

**決策**(反轉 #69「背景階段不重發 idle」的過度保守):auto-resume 也驅動 busy state,但**只在沒有並行前景 turn 時**:
- **provider**(`startServerTurn` / fake `serverturn:`):server turn 開頭發 `status streaming`(帶 server turnId)、結尾發 `idle`(routeServer 既有)。
- **main**(server-turn drain):`if (ev.type==='status' && sessions.get(tabId)?.state==='streaming') continue;` —— 前景 turn 在跑(`session.state==='streaming'`)才跳過 status(保護前景 spinner,即 #69 真正在意的 case);否則(純 auto-resume,前景已 idle)**放行** → spinner 隨 auto-resume busy→idle。

**為何安全**:#69 跳過 status 的唯一理由是「別讓 server turn 的 idle 清掉並行前景 turn 的 spinner」。用 `session.state` 動態判別後,只在該情況跳過,其餘放行 —— 既修了 UX 又保留原本要防的 race。`session.state` 只由前景 `sendMessage` 設(streaming/idle),auto-resume 不碰它,所以判別準確。

**驗證**:`background-tasks.test.ts` M3 測試加斷言「server turn 開頭發 streaming(帶 server turnId)」+ 既有「前景唯一 idle 不受影響」仍綠;E2E 4/4(fake serverturn 加了 streaming,因 E2E 的 serverturn 跑在前景 turn 內 → status 被正確跳過,渲染不變)。

**Related**:#69(task_event lane / server-turn 渲染)、`agent-server/providers/claude/index.ts`(`startServerTurn`)、`agent-server/providers/fake/index.ts`、`src/main/agent/index.ts`(server-turn drain)。

## 77. App-skill bridge:agent 經 in-process MCP 改 client-owned skills + 統一 mutation pipeline + lock

**問題**:要讓 agent 能自己新增/修改 app 層 skills(#71)。skills 的 source-of-truth 在 **client/main**(`<userData>/skills`),但 agent 執行在 **remote / agent-server**。需要一條跨 provider、不讓 renderer 感知 provider 細節(守 #43)的路徑,且要防「agent 亂改全域 skill 造成污染」。

**決策 A — 走 in-process MCP 當 RPC bridge,不是真 server**。兩 provider 各用自家 SDK 的 in-process 工具機制註冊「shelf」工具(claude `createSdkMcpServer({type:'sdk'})`+`tool()`;copilot `defineTool`+`session.registerTools`),工具 handler **不在 agent-server 做事**,而是 `callMain(op,args)` emit `{type:'app_tool',requestId,op,args}` 經既有 stdio wire 給 main → main `handleAppTool` 對 `skills-store` 動作 → 回 `app_tool_result`。等於 **MCP server = agent-server,但只是把意圖 emit 回 main**(client 才是真正的執行主體)。renderer 完全無感(看不到工具名/MCP)。

**決策 B — main 端 dispatcher 用 `op=resource.verb` registry**(`agent/app-tool.ts`,純函式可單測)。每筆標 `safe`:read(`app_skill.list`/`get`)免確認;write(`create`/`update`)`safe:false` → 走 provider 的 tool-permission 確認。**`create` 用 placeholder+rollback**(`createSkill()` 建空殼 → `updateSkill` 寫內容;失敗刪殼);**`update` 先 guard「存在且未 locked」**(見下 + GOTCHAS)。**不開 `delete` 給 agent**(高風險,跟 UI-only 一致)。

**決策 C — 統一 mutation/sync pipeline**(`skills-sync.ts onSkillsChanged()`):**所有觸發點**(manager UI 的 `ipc/skills.ts`、agent bridge 的 `app-tool.ts`)mutation 後**只呼叫 `onSkillsChanged()`**,後續行為集中一處:①本機 re-project ②跑 subscribers(remote re-mirror,由 `agent/index.ts` 經 `subscribeSkillsChanged` 注入 —— **反向注入避免 `remote→app-tool→skills-sync` import cycle**;對 active remote connections 去重 + `setImmediate` 延後,因每次 sync 是 blocking execSync)③`SKILLS_CHANGED` 通知 renderer 刷新。觸發點變「dumb」,只負責寫 store + 喊一聲。**生效時機**:#80 起接 live hot-reload(`reloadSkills` 接在此 pipeline 下游)→ skill 改完自動 reload 進 live session、免重連、下個 turn 生效(原 v1「不做 hot-reload、下一個 session 才生效」已由 #80 取代)。

**決策 D — per-skill lock(防全域污染)**。app skills 是全域的,agent 覆蓋使用者手寫 skill 會污染所有後續 session。`update` 雖已被 permission 確認 gate,但 **bypass/allow-all 模式會繞過** → lock 是不受權限模式影響的硬性「agent 別碰這顆」。實作:folder 內 `.locked` marker(`isSkillLocked`/`setSkillLocked`;**in-folder → rename 自動帶走**,dotfile 不干擾 skill loader),`app_skill.update` 在 main 端檢查 locked 就報錯(**main 端強制 → remote agent + bypass 都擋得住**)。**manager UI 永遠能改/解鎖**(使用者擁有它),**agent 無解鎖工具**(同 delete 立場)。`listSkills` 回 `locked` 供 UI badge + agent 自知。

**為何不在 store 層擋 lock / 為何 `updateSkill` 維持 upsert**:`updateSkill` 的 upsert 行為是 create flow 的依賴(placeholder → 寫入);lock 與「不准 upsert 新建」都是 **bridge(agent)層的契約**,manager UI 走同一個 store 但不受這些限制。故守門加在 `app-tool.ts`,不動 store。

**驗證**:read path + write path(create/update/rename)+ create 撞名 rollback + **update 不存在→報錯不 upsert** + **lock 擋 agent 改、內容完好、list 回 locked:true** 全部**真機 live 驗證通過**(2026-06,直接呼叫 `mcp__shelf__*` 工具)。單測:`app-tool.test.ts`(read/write/lock guard)、`skills-store.test.ts`(lock helpers + rename 帶 marker)。

**Related**:#71(app skills 投影/消費)、#70(taxonomy)、#43(provider 封裝 / renderer 無感)、#72(per-session 載入時機)、`src/main/agent/app-tool.ts`、`src/main/{skills-sync,skills-store,ipc/skills}.ts`、`agent-server/{app-tool-client,app-tool-tools,index}.ts`、`agent-server/providers/{claude,copilot,fake}/index.ts`、`src/renderer/components/SkillsView.tsx`。

## 78. 訊息送出佇列改 server-owned:client 樂觀顯示、agent-server 控時序

**問題**:streaming 時送出的訊息,舊架構排在 **client 端 queue**(`InputZone` 的 `reduceFlush` latch + isStreaming-driven drain),由 client **猜 turn 邊界**。毛病:① client 跟 server 重造同一件事(agent-server 早有 streaming-input 持久 session + sendChain 序列化,#72);② 猜邊界造成 burst-drain race,得加 latch 硬補;③ config slash(`/model`)繞過可見 queue、零回饋。

**決策:草稿/輸入體驗留 client,但 queue 的「控制權(排序 + 釋放時機)」交給 agent-server**。client **eager-send 每則**(送出即發,不 hold)、帶 renderer-mint 的 `clientMsgId`(`crypto.randomUUID()`);agent-server 用**顯式 queue**(`createSendQueue` 純工廠,取代不可內省的 `sendChain` promise-chain)序列化 turn + 每次變動 emit **完整有序快照** `{type:'queue', items:[{clientMsgId, state:'queued'|'running'}]}`(session-level、無 turnId,比照 task_event 在 turnId 檢查前路由到 `onQueue` sink)。client 純鏡像快照畫 chip。

**promote 機制走快照 `state:'running'`,不另開 turn_started**:原設計想重用 `turn_started` 帶 clientMsgId,但 dispatcher 對「已註冊的 foreground turnId」之 `turn_started` 會當 dup 丟、對「未註冊」之 `turn_started` 會開 server turn(#69)→ 衝突。改由快照把「正在跑的那則」標 `running`,renderer 看到 running 就把樂觀 chip **升級成 timeline user bubble**(對齊 CLI:排隊訊息開跑就變「你的訊息」)。`reconcileQueueSnapshot`(純函式,`queue-reconcile.ts`)負責:promote(deduped,FIFO)、queued→chip、用 `confirmed` flag 區分「樂觀未確認(留)」vs「曾在 queue 又消失且沒跑(丟 —— user cancel 已先 client 移除,僅剩 respawn 丟失)」、prune promoted set。

**逐則取消 + ESC**:`cancel_queued {clientMsgId}` 從 queue 移除未跑的那則(running 不可取消);ESC = clear 整個等待 queue + 中斷 running turn。兩者對每個被丟的 send emit **terminal idle on its turnId**,否則 main 為它註冊的 per-turn generator 永遠 hang。

**main 端 `activeTurns` 計數器**:eager-send 後 main 同時跑 N 個 sendMessage generator(agent-server 序列化,但 main 各持一個),用計數器讓 `session.state` 維持 streaming 到**最後一則** drain 完,否則第一則的 finally 會提早翻 idle、破壞 server-turn busy-skip。renderer 端 spinner / ESC 用 `busy = isStreaming || pendingSends.length>0` 蓋掉 turn 間的短暫 idle 閃爍。

**reconnect(v1 = 丟+不自動重送)**:現況斷線 = respawn(stdio pipe 是命脈),in-memory queue 一定沒;reconnect → 空快照 → reconcile 把 confirmed-but-vanished 的丟掉。不自動重送(respawn 也丟了去重記憶,跨行程無法用 clientMsgId 擋 dup);auto-resend 列後續 hardening。

**純函式 + 單測**:`agent-server/send-queue.ts`(enqueue/pump/cancel/clear/snapshot,7 cases)、`src/renderer/queue-reconcile.ts`(promote/confirm/drop/prune,10 cases)、dispatcher queue 路由(2 cases)。刪除 `queue-flush.ts`(reduceFlush latch obsolete)+ store 舊 `queuedMessages` API。

**Related**:#72(streaming-input 持久 session,序列化的根)、#69(task_event session-level lane,queue 比照之)、`agent-server/{index,send-queue}.ts`、`src/main/agent/{index,remote,turn-dispatcher,types}.ts`、`src/renderer/{agentTabStore,queue-reconcile,agentTabSubscriptions}.ts`、`src/renderer/components/agent/{InputZone,MessageList}.tsx`、`src/shared/{ipc-channels,types}.ts`(`AGENT_QUEUE`/`AGENT_CANCEL_QUEUED`/`AgentQueueItem`)。

## 79. `/mcp` `/skills` provider 內部攔截 → 印 normalized 唯讀卡片（不轉發 SDK）

**問題**：使用者要「直觀看到這個 session 實際載入了哪些 MCP server / skill」。但 `/mcp` `/skills` 在兩家 CLI 都是**互動式 TUI-only**，**SDK / headless 不可派發**（Claude 官方："Only commands that work without an interactive terminal are dispatchable through the SDK"；`system/init.slash_commands` 只列 clear/compact/context/usage）。轉發給 SDK 會失敗或被當普通 prompt 餵給模型。

**決策**：**provider 內部攔截 `/mcp` `/skills`（像 `/model`），自己讀 SDK 的結構化資料 → normalize → 印 `fold_markdown` 卡片**。renderer / wire / main **零改**（重用既有 message + fold 渲染）。純 provider 端。

- **資料來源（init 抓一次、normalize、cache；reconnect 刷新）**：
  - **Claude**：`Query.mcpServerStatus()`（`/mcp`）+ `supportedCommands()`（`/skills`）。**關鍵**：在 **REAL persistent session 的 `system/init`** 抓（`refreshLoadedContext()`，full options：app-skill plugins + in-process MCP + cwd），**不是 warmup probe**（cwd-only，會漏 app skills + in-process `shelf` bridge）。
  - **Copilot**：`session.skills_loaded` / `session.mcp_servers_loaded` event（從 `KNOWN_IGNORED` 移出，抓進 cache）。
- **正規化形狀**：`NormalizedMcpServer { name, status, error?, source? }`、`NormalizedSkill { name, description?, source?, enabled? }`。**不對稱（SDK 限制）**：`source`/`enabled` 只有 Copilot 給得出 —— Claude `SlashCommand` 無 source 也無 skill 標記，故 **Claude `/skills` = `supportedCommands()` 去掉已知 built-ins**（=自訂 command + skills，無 source）；Copilot 是真正 `skills_loaded`（有 source，custom→app）。
- **list ↔ dispatch 成對**：`mcp`/`skills` 加進 command list（Claude `CLAUDE_BUILTIN_COMMANDS`、Copilot `SLASH_COMMANDS`）**且**實作攔截 —— 只列不攔會被當普通 prompt 餵模型（claude `/help` 就是因沒 dispatch 而被註解掉的前車之鑑）。
- **MCP = 多 tool**：一個 server 暴露一組 tool（`mcp__<server>__<tool>`）；卡片顯示單位是 server（name+status），v1 不列底下 tool。

**為何不做 StatusBar popover（原備案）**：slash 攔截重用 fold 渲染、renderer/wire 零改、對齊原生 CLI 手感。popover（常駐一覽）列為日後可選，資料層沿用。

**純函式 + 驗證**：`agent-server/providers/loaded-context.ts`（normalize\* + formatMcpCard/formatSkillsCard，9 unit cases）；fake provider + e2e（`/mcp` `/skills` → 卡片內容，`agent-flows.spec.ts`）。**待真機驗**：Claude in-process `shelf` bridge 是否進 `mcpServerStatus()`（可能只報 process/HTTP server）；Copilot event cache 時機（極早打 /mcp 可能 cache 空）。

**Related**：#43（provider 封裝 / renderer 無感）、PRODUCT #5（原生的歸原生）、`agent-server/providers/{loaded-context,claude/index,copilot/index,fake/index}.ts`。

---

## 80. App-skill **live hot-reload**：skill 改完免重連即生效（取代 #71/#77/#79 的「v1 不做 hot-reload」）

**問題**：#71/#77 收尾時 v1 不做 hot-reload，生效時機 = 下一個 session（plugins/skillDirectories 在持久 session 建立時載入一次）。使用者直覺是「UI 改完 skill,最多 project reconnect 就該吃到新的」,但**連線是跨 project 共用的**——要真正重連得把所有 project 都 disconnect,極不直覺;且既有「reconnect」其實走 `resumeSession`/resume pointer,會把舊 skill 快照一起接回來,根本沒重掃。結果使用者改完 skill 怎樣都看不到新的。

**決策**：兩家 SDK 都有 live-reload API（2026-06 查證安裝版本），接成 `ServerBackend.reloadSkills?()`,skill 改 → 自動 reload 進每個 live session,**免重連、不丟對話歷史**,該 session **下一個 turn** 生效。

- **provider API（best-effort，無 live session = no-op，失敗 log + 退回「下次 init 生效」）**：
  - **Copilot**：`session.rpc.skills.reload()`（`@github/copilot-sdk@1.0.0-beta.1`,`rpc.d.ts` session-scoped,標 `@experimental`;CLI `/skills reload` 的程式化對應）。
  - **Claude**：`query.reloadPlugins()`（`@anthropic-ai/claude-agent-sdk@0.3.159`,**文件化非實驗**:"reload plugins from disk";app skill 本就以 local plugin 注入,故 reloadPlugins 即重掃)。回傳 refreshed `commands`/`mcpServers` → 直接更新 `/skills` `/mcp` cache。
- **觸發鏈**：`skills-sync.ts onSkillsChanged()`(既有,先把檔案投影/sync 到消費路徑)→ `agent/index.ts subscribeSkillsChanged`(本次擴充)→ **local session 立即 reload**(檔案已同步落地);**remote session 先 `syncSkillsForConnection` 再 reload**(檔案要先 mirror 到 remote;sync 失敗就不 reload,免重載舊檔)→ `remote.ts reloadSkills()` `sendLine({type:'reload_skills'})` → `agent-server/index.ts` dispatch **對所有 backend** `reloadSkills?.()`(skill 是 app 全域,非 per-session)。
- **per-session reload**:每個 tab 是獨立 agent-server process,故 reload 逐 session 打,不是逐 connection。
- **⚠️ Claude 限制（已記 GOTCHAS）**：reloadPlugins 讓 model 能用**新增** skill,但**不重建 `/` slash 解析索引** → 全新 skill 直接打 `/<name>` 仍可能 "Unknown skill" / 不進 autocomplete,要整個 restart。**改既有 skill 內容不受此限**(名稱已存在)。我們情境(skill 給 model 用、`/skills` 卡自己用回傳值重組)影響小。

**不要**：別把「reconnect 才生效」當解 —— 連線跨 project 共用,reconnect 體驗差且 resume 會接回舊快照;也別為 reload 改走 fresh `createSession`(會丟 CLI 端對話記憶),既然有 in-place reload API 就用它。

**測試**：`reloadSkills` 為 best-effort no-op（無 session 不 throw、不碰 SDK）的迴歸測試（copilot `slash-commands.test.ts`、claude `claude.test.ts`）。真機 reload 行為靠 build + dev 驗（agent-server bundle 改動）。

**Related**：#71（app skills 投影/消費,本決策推翻其「v1 不做 hot-reload」)、#77（統一 mutation pipeline,reload 接在 `onSkillsChanged` 下游)、#79（`/skills` `/mcp` cache,reload 後一併刷新)、#70（taxonomy）、#43（provider 封裝)、`src/main/agent/{index,remote,types}.ts`、`agent-server/{index}.ts`、`agent-server/providers/{types,claude/index,copilot/index}.ts`。
