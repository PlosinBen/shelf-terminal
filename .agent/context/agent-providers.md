---
type: context
title: Agent Providers
related:
  - architecture/agent-turn
  - contracts/agent-routing
  - context/agent-core
  - context/agent-config-flow
  - context/agent-ui
---

# Agent Providers

> 多個 agent provider（Claude / Copilot / 未來 OpenAI-compatible）對外一致、差異封裝在內部：auth、model registry、permission semantics 全收進 provider，renderer 對 provider type 無知。

## agent-providers#1 — Provider 行為對外一致，差異封裝在 Provider 內部  ·  [Decision]

**Decision**：所有 agent provider（Claude / Copilot / 未來其他 OpenAI-compatible）對 renderer 暴露同一組介面（`gatherCapabilities`、`query`、`stop` 等）。Provider 之間的行為差異（model list 來源、slash command 語意、context 管理策略、auth 流程）一律封裝在 provider 內部。Renderer 對 provider type 無知。

**典型差異點**：
- **Model list**：Claude 寫死 / Copilot API 動態抓 / 未來 generic 由 user 配置 → 一律經 `gatherCapabilities().models` 出來，client 不用判斷怎麼來的
- **Slash commands**：provider 在 `query()` 入口自行偵測 `/cmd` prefix 並內部 dispatch（見 `agent-config-flow#2`）— renderer 不分流
- **Context 管理**：Claude SDK 自管 / Copilot modelMessages + auto-compact → 都在 provider 內部
- **Auth**：Claude OAuth token / Copilot session token → 都包成 `auth_required` event

**Reason**：承 CLAUDE.md Conventions「Agent backend 封裝在 agent-server/」。具體效益：行為差異隔離後可分別演進（Copilot 加新 slash 不影響 Claude）；IPC contract 穩定（provider 內部重構不影響前端）。

**Anti-pattern（不該這樣做）**：
- Renderer 寫死 `if (provider === 'copilot') ...` 攔截特定 slash command
- Renderer 知道某個 provider 的 model list 要動態 refetch、另一個不用
- Status bar 或 SettingsPanel 為某個 provider 開特殊 UI 分支
- IPC payload 帶 provider type 讓 main / agent-server 判斷怎麼處理

**Exception**：純 UI 呈現（例如 provider 名稱顯示為 "Claude" / "Copilot"）可以在 renderer 處理 — 那是 i18n 等級的東西，不是 agent 邏輯。

**Do not change casually because**：不要為了「圖方便」在 renderer 加 provider-specific 條件分支 — 短期省 5 行 code，長期回頭重構要付 5 倍代價。新需求進來時先問「能不能塞進 provider 介面」，不行才考慮擴介面，最後才動 renderer。

## agent-providers#2 — Copilot 依賴 CLI 自己的登入狀態，token 不經手；`gh` 為「有就用、沒有也行」的選用捷徑  ·  [Decision]

**Decision（現行 = 過渡版 dual-path）**：`CopilotClient` 啟動時：
- **有 `gh` 且已登入** → 跑 `gh auth token` 拿 token，當 `gitHubToken` 傳入（`useLoggedInUser:false`）。Copilot CLI 用這個 token、**不讀自己 keychain 的登入** → 不跳 macOS Keychain 提示（gh 把 token 存純文字檔、非 keychain）。
- **沒 `gh`** → fallback `useLoggedInUser: true`，吃 Copilot CLI 自己的 OAuth / device-flow 登入（macOS 上存 keychain，未簽章 build 可能跳提示）。

純決策 helper `buildCopilotAuthConfig(ghToken)`（`copilot/helpers.ts`，單測）+ 不 throw 的 `readGhToken()`（`copilot/index.ts`，gh 缺/未登入/空輸出一律回 undefined）。

**Reason**：
- 跟 Claude 一致：不經手/不自存 token，依賴本機官方 CLI 的登入狀態（`agent-providers#1`）。
- **`gh` 是選用捷徑、不是硬依賴**：沒裝照樣能跑（走 useLoggedInUser）。裝了就用它繞過 keychain 提示——這是為了**未簽章 macOS build 的 UX**（見「過渡」段）。遠端執行時 `gh auth token` 在遠端跑、拿的是遠端自己的 gh，與 Copilot 同處，語意正確。

**Do not change casually because**：
- 不要把 `gh` 變成**硬依賴**（沒 gh 就 throw）— 它是 optional fallback，缺了要能走 useLoggedInUser。
- 不要自己存 token 到 userData — keychain ACL 是 per-binary 綁定，自存等於把 GitHub OAuth refresh 邏輯重做一遍（這是「方案 B / 自管 token」要付的代價，過渡版刻意不做）。

**Transition（為何 dual-path）**：未簽章 macOS app 開 Copilot tab 會跳 Keychain 提示（拔 gh 改 `useLoggedInUser:true` 後 copilot 改讀自己 keychain token 所致）。對一般 user 觀感差。**永久解未定**（A:code signing / B:Shelf 自管 token），先上這版「有 gh 就用舊 flow 繞過、沒 gh 才走現 flow」當過渡。

## agent-providers#3 — Agent provider custom model registry — Claude merge SDK + user，Copilot 簽名對稱但忽略  ·  [Decision]

**Decision**：`gatherCapabilities(cwd, sessionId, customModels?)` 簽名統一加 `customModels?: ProviderModel[]`。Claude 用 pure `mergeClaudeModels()` 把 SDK 動態 list 跟 user 自訂 entry 合併（同 id 以 user 覆寫）；Copilot 簽名收下但函式內忽略 + 註解。

`AppSettings.providerModels` key 從 `PmProviderType` 廣化成 `PmProviderType | 'claude'`。Settings UI 用 `AGENT_PROVIDER_REGISTRY`（目前只有 Claude）多渲染一個 section，行為跟 PM provider section 一致。Main 在 `startSession` 時 `loadSettings()`，把 `providerModels[provider]` 透過 `getCapabilities` → IPC → agent-server 傳到 backend，session 內 closure cache（user 改 settings 要重開 agent tab 才生效，不做 hot reload）。

**Reason**：
- Claude SDK `supportedModels()` 只回 4 個 alias，抓不到舊版 full ID（如 `claude-opus-4-6`）。User 要舊版又不想我們寫死預設 list（會跟 SDK drift）
- Copilot SDK server-side 驗證 model 名稱，custom 會被拒；介面對稱但忽略比 throw 更乾淨，未來 API 改了拿掉 `_` 前綴即可

**Do not change casually because**：
- 不要在 Settings UI 列 SDK 預設 model — 會 drift；Models tab 只列 user 自訂 entry
- 不要把 Copilot 塞進 `AGENT_PROVIDER_REGISTRY` — SDK 會拒，UI 給 user 設了沒效果只會誤導
- 不要在 renderer 直接讀 settings — 走 main 的 `loadSettings`，避免 renderer 感知 main 的 storage layout

## agent-providers#4 — Permission semantics 全部收進 provider，dispatcher 只做 IPC routing  ·  [Decision]

**Decision**：所有跟 permission 相關的行為細節（bypass 短路、acceptEdits 自動允許、plan mode 阻擋、session allowlist「always allow this tool」）都實作在 `agent-server/providers/<name>.ts` 裡。`agent-server/index.ts` (dispatcher) 不存任何 permission 狀態、不做任何 mode 判斷，只負責 IPC routing 和 backend lifecycle。

**Reason**：
- 承 CLAUDE.md Conventions + `agent-providers#1`。具體在 permission 領域：兩 provider SDK 對 permission 支援深度不一樣（Claude `updatedPermissions` addRules destination=session / Copilot `kind`-based + native `autopilot`），硬抽到 dispatcher 會走最低公分母、放棄各自 SDK 最原生機制
- session allowlist 在 Claude 是「白送」（回 `updatedPermissions` 後 SDK 自己接管，連 `canUseTool` 都不會再 invoke）；dispatcher 一律「自己存 Set」就丟掉這個白賺

**Companion details**：
- `bypassPermissions`：Claude 在 `canUseTool` 開頭 short-circuit auto-allow，SDK 的 `permissionMode` 一律送 `'default'`（避開 `allowDangerouslySkipPermissions` 旗標）；Copilot 走 native `autopilot` SessionMode
- `plan` / `acceptEdits`：Claude 透傳 SDK（兩者 SDK 內建語意非平凡，不要重造）；Copilot adapter 自己決定怎麼對應（`acceptEdits` 目前無對應就從 capability list 拿掉，"honest capability surface"）
- session allowlist (未來)：Claude 用 SDK `updatedPermissions: [{type:'addRules', destination:'session', ...}]`；Copilot 看 SDK 支援度，沒對應就 provider 內 closure `Set<string>` fallback
- Permission popup 第三按鈕「Allow for session」由 renderer 加，但「session allow 之後怎麼記住」是 provider 的責任
- **Capability descriptor（label / severity）走中央定義**：`PERMISSION_MODES` / `EFFORT_LEVELS` 放 `agent-server/providers/types.ts`，provider 用 `pickPermissionModes(['default', 'plan', ...])` 宣告支援哪些 ID。Provider 自證「我支援什麼」，不重複定義 displayName 或 severity（那是 app 層級的 UX 一致性）

**Do not change casually because**：
- 不要在 dispatcher 加 `Map<provider, Set<toolName>>` 之類的 cross-provider permission 狀態 — 看似 DRY，實際上強迫所有 provider 走最低公分母
- 不要為了「對稱」逼 Claude 不用 `updatedPermissions` 改自己存 Set — SDK 白送的不要不拿

## agent-providers#5 — Copilot 工具卡片可能永遠 running（`tool.execution_complete` 不回）—— turn 結束要收尾孤兒卡  ·  [Gotcha]

**Symptom**：Copilot 跑大範圍 `rg`/grep（本機），工具卡片無限「running」，**從不結束、也不報錯**。看起來像 bash/工具沒回應。

**Root cause**：每個 tool 的卡片在 `tool.execution_start` 建立、進 `inflightToolUses`，要等對應 `tool.execution_complete` 才填好結果並移除。但 Copilot CLI 內部某些工具（觀察到大範圍 rg）會**卡死、永遠不發 `tool.execution_complete`** —— 上游問題，我們改不了它本身。turn 層 `sendAndWait` 要到 30 分鐘 timeout 才丟錯（且 SDK 文件明載 timeout「does not abort in-flight agent work」），使用者不會等那麼久 → 卡片無聲空轉。SDK 也**不串流**工具中間輸出（`tool.execution_partial_result` 實測 `partials:0`），所以期間零回饋。

**Fix**：turn 結束（success / error / timeout / **使用者按 Stop→abort**）一律走 `query()` 的 `finally` → `finalizeOrphanedToolCards()`：把 `inflightToolUses` 殘留的卡片各發一張帶 `errorMessage` 的終止卡（同 msgId 讓 renderer upsert），大聲 `console.warn` 留痕，再清空 map。決策抽成純函式 `buildOrphanFinalizeMessages`（helpers.ts）可單測。實際效果：使用者按 Stop 即把空轉卡片變「Tool did not complete…」紅字，不用乾等 30 分鐘。**這只治「靜默空轉」，不治根因（CLI 工具卡死）。別把 timeout 從 30 分鐘調短來「解決」—— 會誤殺正常的長 turn；問題在孤兒卡沒收尾，不在 timeout 值。**

## agent-providers#6 — 列表類 provider 輸出 = 各 provider 自組渲染原語（md），不建共通 result type  ·  [Decision]

**Decision**：像 `/mcp` `/skills` 這種「列出 session 載入了什麼」的輸出,**每個 provider 用自己的 SDK 形狀直接組 markdown**(渲染原語)再 `reply` 出去。**不**先把各家資料 normalize 成一個跨 provider 的共通結果型別(如先前的 `NormalizedMcpServer`/`NormalizedSkill`)。共通層只保留**無語意的排版工具**(`agent-server/providers/md-table.ts` 的 `mdTable`/`cell`)。各 provider 的「raw SDK shape → md string」是純函式,各自單測(`{claude,copilot}/mcp-skills-cards.test.ts`)。

**Reason / 為什麼**:共通 result type 是**最低公分母契約** —— 各家資料天生不對稱(Claude `mcpServerStatus().tools` 帶 per-server tools + `readOnly`/`destructive` annotations;Copilot 的 `mcp_servers_loaded` / `mcp.list()` / `mcp.discover()` 三者都**沒有** per-server tools),硬塞進共通型別只能靠一堆 optional 欄 + adaptive column 撐,愈加愈漏。更糟的是**權責倒置**:把「怎麼呈現」的責任從各 provider 上收到共通層,等於逼共通層去懂每一家的 quirks,新 provider 進來得先滿足這個型別 → 不利擴充。承 `agent-providers#1`(差異封裝在 provider 內)+ CLAUDE.md「wire 給 renderer 的是渲染原語,不是 provider 語意」:呈現本就是 per-provider 的事,直接在 provider 內組 md 最誠實。

**結果**:Claude `/mcp` 每 server 巢狀列 tools(+annotation 標記);Copilot `/mcp` 只列 server(沒可靠 per-server tool 來源 —— 要補得走 client 級 `tools.list()` + `namespacedName` 前綴 group,未驗證,deferred)。兩家卡片不同,在此決策下**合法**,renderer 無感(都只收到 `reply` markdown)。

**Do not change casually because**:不要「為了一致」再把這類輸出抽回共通 normalized struct —— 那會重新把各家差異上收到共通層,造成權責倒置、卡住新 provider。要共用就只共用 `md-table` 這種無語意工具。判準:**跨 provider 共用「無語意工具」可以,共用「帶語意的結果型別」不行**。

**Related**:`agent-providers#1`、`skills#3`、CLAUDE.md Conventions(渲染原語)、`agent-server/providers/{md-table,claude/helpers,copilot/helpers,fake/index}.ts`。

## agent-providers#7 — Claude SDK `rate_limit_event` 在 `status:'allowed'` 不帶 `utilization` —— status bar quota 平常只能顯示 bucket+reset  ·  [Gotcha]

**Symptom**:Claude 的 status bar quota 段平常長 `5h: — ↻3h`(bucket 名稱 + reset 倒數，但百分比是 `—`),只有配額快爆或已擋時才會冒出真正的 `%`。看起來像我們算漏了 utilization。

**Root cause**:SDK 的 `SDKRateLimitInfo.utilization` **只在 `status === 'allowed_warning' | 'rejected'` 才有值**;正常的 `'allowed'` 態被 SDK 靜默丟掉 —— 即使底層 `anthropic-ratelimit-unified-*-utilization` HTTP header 一直帶著這個數字。這是上游限制,不是我們的 bug。(另 `resetsAt` 是 Unix 秒、`formatResetCountdown` 吃毫秒,故 `*1000`。)

**Fix / workaround**:`claude/helpers.ts` 的 `rateLimitInfoToSegment` 在沒有 `utilization` 時 render `—` fallback(保留 bucket + reset countdown),有值才算 severity。`claude/index.ts` 的 `rate_limit_event` case 把段落累進 `rateLimitBuckets` 後掛在 streaming status 上送出。**別把 `—` fallback 或 `*1000` 當多餘 code 拿掉 —— 它們是刻意繞 SDK 的。** 上游追蹤見 `UPSTREAM_ISSUE.md`(claude-code #50518,落地後可移除 `—` fallback、改讀真值)。

**Related**:`agent-providers#1`、`agent-core#10`(Copilot 把 quota 掛在 mid-turn streaming status 上)、`agent-server/providers/claude/{helpers,index}.ts`、`UPSTREAM_ISSUE.md`。

## agent-providers#8 — streaming-input session 下 `/compact` 完成訊號是 `compact_boundary`,不是 `compact_result`  ·  [Gotcha]

SDK 0.3.159 **並存**兩種 compact 完成訊號:`status` 形狀(`subtype:'status'` + `compact_result` + `compact_error`,`sdk.d.ts:3585`)與 `SDKCompactBoundaryMessage`(`subtype:'compact_boundary'` + `compact_metadata`,`sdk.d.ts:2646`)。但**現行 streaming-input persistent-session 模式只發 `compact_boundary`、不發 `status`+`compact_result`**。所以偵測 `/compact` 完成一律判 `subtype === 'compact_boundary'`(純函式 `isCompactBoundary(msg)`)。**別改回 `compact_result`** —— 它雖仍在 SDK 型別裡,但這個 session 模式不會發它,選了就每次卡「Compaction did not complete」(靠 `closeForegroundTurn` fallback)。失敗沒有獨立訊號:boundary 不來就是失敗,無 `compact_error` 明細。若日後 session 模式或 boundary 形狀再變,先看 `sdk.d.ts` 的 `SDKCompactBoundaryMessage` 真實定義再改。

**Related**:`agent-config-flow#2`(`/compact` 走真 SDK turn + `stoppable=false`)、`background-tasks#1`(`pendingCompactMsgId` per-turn 狀態)、`agent-server/providers/claude/index.ts` 的 `isCompactBoundary`/`routeForeground`。

## agent-providers#9 — `@github/copilot-sdk` 與 `@github/copilot` CLI 必須配成「同步發佈的一對」，別各自 pin  ·  [Gotcha]

**Symptom**：copilot 啟動失敗 —— dispatcher stderr `[CLI subprocess] error: too many arguments. Expected 0 arguments but got 1.` → CLI server exit code 1 → `getAuthStatus`/`listModels` 全回「Connection is closed」→ caps init failed。Claude 正常,只有 copilot 掛。

**Root cause**：SDK 與 CLI 是**綁定發佈的一對**(官方 SDK 的 `dependencies` 直接釘 `@github/copilot` 版本,如 sdk `1.0.5` → `^1.0.67`)。我們曾**分開 pin**:`@github/copilot-sdk@1.0.0-beta.1`(很舊)+ CLI `1.0.56`。beta.1 宣告範圍 `^1.0.41-0` 雖含 1.0.56(semver 不報),但 CLI 在 1.0.41→1.0.56 間**改了 SDK spawn CLI server 的引數契約** → 舊 SDK 用 `cliPath`+`useStdio` 起新 CLI 就被拒。且我們的 copilot unit test **mock 掉 `@github/copilot-sdk`**,真實 CLI spawn 的引數不相容**測不到**,所以沒被擋。

**Fix / 現況**：升成相容對 **sdk `1.0.5` + CLI `1.0.68`**(transitive,`@github/copilot` 非直接 dep;`COPILOT_CLI_VERSION` 常數必須 = 實裝版本,有 drift-guard 測試)。API 變更兩處:① client 建構子 `cliPath`+`useStdio` → `connection: RuntimeConnection.forStdio({ path })`(**這就是修 bug 的關鍵**)② elicitation handler 從 post-create `session.registerElicitationHandler()` 改成 session config 欄位 `onElicitationRequest`(ctx/result 形狀不變)。auth(`gitHubToken`/`useLoggedInUser`)、SessionConfig 欄位、`session.on`/`sendAndWait`/`listModels`/`getAuthStatus`、`ModeSetRequest` 的 `interactive|plan|autopilot` 值 —— 都不變。

**CLI 套件佈局也變了(≥1.0.67)**:meta 套件 `@github/copilot` 從「內含可跑的 `index.js` dispatcher」瘦成**只剩 `npm-loader.js`**(`bin.copilot`,ESM),真正執行檔搬進**平台套件** `@github/copilot-<platform>-<arch>`(裡面有 standalone `copilot` binary + `builtin/`/`tree-sitter.wasm` 等資源)。所以 local 不能再指 meta 的 `index.js`(不存在了)—— `resolveCopilotCliPath()` 改指**平台套件的 standalone `copilot` binary**(dev = `node_modules/@github/copilot-<plat>-<arch>/copilot`;packaged = extraResources `copilot-cli/@github/copilot-<plat>-<arch>/`,electron-builder filter `copilot-*-*/**/*` 只會抓到建置機當前平台那顆;remote R1 本就指 standalone binary,未受影響)。這也統一了三環境:全部指 standalone binary、直接 spawn 不經 node。

**Do not change casually because**：升 SDK 或 CLI **只能成對升**,升一邊就對照官方 SDK 該版 `dependencies` 釘的 CLL 版本、同步改 `COPILOT_CLI_VERSION`(+ 確認 `@github/copilot-<platform>` 平台套件該版存在,remote deploy 要抓)。**別**倚賴 unit test 擋相容性 —— 它 mock SDK,只有真機登入 copilot 起 session 才驗得到 rpc method / event 欄位有沒有被改名(`(session as any).rpc.*` 是 untyped)。

**Related**:`deployment#4`(copilot CLI 是 node app、走 CLI 版本)、`agent-providers#2`(gh token 走 `gitHubToken`)、`src/main/agent/agent-runtime-versions.ts`(`COPILOT_CLI_VERSION` + drift-guard 測試)、`agent-server/providers/copilot/index.ts`(`ensureClient` 建構子 / `ensureSession` 的 `onElicitationRequest`)。

## agent-providers#10 — Copilot 互動式登入靠 CLI `copilot login` device flow，不靠 SDK、不自刻 client_id  ·  [Decision]

**背景**：Copilot auth 會過期，需要 app 內一鍵重新登入。`@github/copilot-sdk` **不提供互動式帳號登入**：SDK↔CLI 是 headless stdio-RPC（無 TTY，不吐 device URL），唯一帳號 auth RPC `account.login` 只把「已拿到的 `{host,login,token}`」存進 keychain，**不發起** device flow（沒有回 `verification_uri`/`user_code` 的 RPC；會回 URL 的只有 MCP oauth，與帳號無關）。

**Decision**：由 agent-server spawn CLI 的 `copilot login`（OAuth device flow）驅動登入。實測（Docker headless）確認：無瀏覽器/無 TTY 下它**印出 `To authenticate, visit <url> and enter code <XXXX-XXXX>` 後持續輪詢**，格式穩定；local（有瀏覽器）時 CLI 還會自動開瀏覽器。所以：
- **CLI 擁有 OAuth client_id**，我們不碰未公開的 client_id（自刻 device flow 會被迫拿它 → 破裂風險）。
- agent-server `parseLoginPrompt` 抽 stdout 的 `{verificationUri,userCode}`（純函式，`copilot/login.ts`），走 wire `auth_login_prompt` 回 main；**main 端用 `shell.openExternal` 開「本機」系統瀏覽器**（`openLoginUrl`，預填 `?user_code=`）。這對 **remote 是必要的**：CLI 跑遠端、輪詢與 credential 寫在遠端（正確，SDK 也在那讀），但人在本機 → URL 必須開在本機瀏覽器。
- **成功 = login 進程 exit 0**（不靠 parse 判成敗，只靠 parse 取 URL/code）；取消 = kill；失敗 = 非 0（`auth_login_done{ok,cancelled,error}`）。
- **spawn env 必須剝除 `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`**（`scrubLoginEnv`）—— 否則 CLI 依 `copilot help environment` 的優先序直接吃 token 短路、不走瀏覽器。
- login child 是 agent-server **直接子進程**（非 `setsid` detached）→ 不進 reaper（那是給逃離 process tree 的 detached shell），改在 `dispose()` kill。

**AuthPane**：oauth kind 顯示「Login with GitHub」按鈕（呼叫 `agent.startLogin` 直接 IPC，像 `checkAuth`）；輪詢中顯示 **可點的預填 URL（`prefilledUri`，`<a target="_blank">` → `setWindowOpenHandler` → 系統瀏覽器）** + `userCode` + Waiting + Cancel。可點 URL 是「一律呈現」的可靠備援，不倚賴 `openLoginUrl` 自動開瀏覽器成功；`auth_login_done{ok}` → `finishLogin` 清 pane（authRequired→null），cancel 不視為 error，fail 顯示 error。

**Do not change casually because**：① 別改成自刻 GitHub device flow（B 案）—— 要拿未公開的 Copilot client_id，破裂/維護風險高，除非官方提供穩定 SDK 登入 API。② 別把開瀏覽器改成在 agent-server 端（remote 沒有可用瀏覽器）—— 一律回 main 用 `shell.openExternal`。③ 別忘了 env 剝 token，否則互動登入會被既有 token 短路。

**Related**：`contracts/agent-wire-protocol`（`auth_login_prompt`/`auth_login_done`）、`contracts/ipc-channels`（`agent:start-login`/`cancel-login`/`login-prompt`/`login-done`）、`agent-providers#2`（gh token 路徑，與互動登入正交並存）、`agent-server/providers/copilot/login.ts`、`src/main/agent/index.ts`（`openLoginUrl`）、`src/renderer/components/agent/AuthPane.tsx`。
