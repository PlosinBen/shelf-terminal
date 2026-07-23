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

## agent-providers#2 — Copilot 依賴 CLI 自己的登入狀態、token 不經手（原則保留；SDK dual-path 機制已於 cutover 刪除）  ·  [Decision]

**現況（copilot = ACP backend 後）**：原則不變 —— Shelf 不經手/不自存 copilot 憑證,依賴官方 CLI 自己的登入狀態（同 `agent-providers#1`）。但**實作機制已換**:`copilot --acp` 靠 CLI 自身的登入（device-login `agent-providers#10`、token-env `agent-providers#12`),per-appId 隔離（`agent-providers#15`）。

**已刪除（superseded）**:原本 native SDK backend 的 auth dual-path —— `CopilotClient` 啟動時「有 `gh` → `gh auth token` 當 `gitHubToken`（`useLoggedInUser:false`）繞 keychain / 沒 `gh` → `useLoggedInUser:true`」+ helper `buildCopilotAuthConfig`/`readGhToken` —— **隨 native SDK backend 一起刪除**。它是為未簽章 macOS build 繞 Keychain 提示的過渡設計,ACP 不經 SDK spawn CLI server、無此 keychain 問題,不再需要。

**Do not change casually because**：別以為 copilot 還有 `gh auth token`/`useLoggedInUser` 這條 —— 那是已刪的 SDK 路徑。現行 auth 看 `agent-providers#10`/#12/#15。

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

**Decision**：像 `/mcp` `/skills` 這種「列出 session 載入了什麼」的輸出,**每個 provider 用自己的 SDK 形狀直接組 markdown**(渲染原語)再 `reply` 出去。**不**先把各家資料 normalize 成一個跨 provider 的共通結果型別(如先前的 `NormalizedMcpServer`/`NormalizedSkill`)。共通層只保留**無語意的排版工具**(`agent-server/providers/md-table.ts` 的 `mdTable`/`cell`)。各 provider 的「raw SDK shape → md string」是純函式,各自單測(`claude/mcp-skills-cards.test.ts`)。（**cutover 後只剩 claude 是此決策的活實例**:copilot/codex 走 ACP,`/mcp` `/skills` 原生派發、Shelf 不組卡片,見 `agent-providers#13`(c)、`skills#3` 適用範圍註。）

**Reason / 為什麼**:共通 result type 是**最低公分母契約** —— 各家資料天生不對稱(Claude `mcpServerStatus().tools` 帶 per-server tools + `readOnly`/`destructive` annotations;Copilot 的 `mcp_servers_loaded` / `mcp.list()` / `mcp.discover()` 三者都**沒有** per-server tools),硬塞進共通型別只能靠一堆 optional 欄 + adaptive column 撐,愈加愈漏。更糟的是**權責倒置**:把「怎麼呈現」的責任從各 provider 上收到共通層,等於逼共通層去懂每一家的 quirks,新 provider 進來得先滿足這個型別 → 不利擴充。承 `agent-providers#1`(差異封裝在 provider 內)+ CLAUDE.md「wire 給 renderer 的是渲染原語,不是 provider 語意」:呈現本就是 per-provider 的事,直接在 provider 內組 md 最誠實。

**結果**:Claude `/mcp` 每 server 巢狀列 tools(+annotation 標記),自組卡片;copilot/codex(ACP)不走此路 —— slash 原生派發、CLI 自己吐輸出。此決策下**合法**,renderer 無感(claude 收到 `reply` markdown;ACP provider 的 slash 由 CLI 處理)。（Reason 段的 Copilot SDK 資料不對稱是 native 時代的佐證,現屬對照史。）

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

## agent-providers#9 — Copilot 跑 standalone CLI binary（`copilot --acp`），不再用 `@github/copilot-sdk`；binary 版本/平台套件仍要管  ·  [Decision]

**現況（copilot = ACP backend 後）**：copilot **直接 spawn standalone CLI binary + `--acp`**（ACP server over stdio）,**不再依賴 `@github/copilot-sdk`**（SDK backend 已於 cutover 刪除,SDK↔CLI 版本配對那整套限制隨之消失）。

`resolveCopilotBinary()`（`copilot/helpers.ts`）三環境都指**平台套件 `@github/copilot-<platform>-<arch>` 的 standalone `copilot` binary**:dev = `node_modules/...`;packaged = extraResources `copilot-cli/@github/copilot-<plat>-<arch>/`（electron-builder filter 只抓建置機平台那顆）;remote self-contained deploy ship 該 binary。CLI meta 套件 `@github/copilot`（≥1.0.67）只剩 `npm-loader.js`,真正 binary 在平台套件裡。`COPILOT_CLI_VERSION`（`agent-runtime-versions.ts`,drift-guard 測試）必須 = 實裝 CLI 版本。

**Do not change casually because**：別再引入 `@github/copilot-sdk`（已刻意移除,ACP 是直接 CLI 協定,不需要 SDK 中介）;升 CLI 版本同步改 `COPILOT_CLI_VERSION` + 確認平台套件該版存在（remote deploy 要抓）。

**Related**：`deployment#4`（copilot CLI 走 CLI 版本）、`agent-providers#13`（走 ACP）、`src/main/agent/agent-runtime-versions.ts`、`agent-server/providers/copilot/helpers.ts`（`resolveCopilotBinary`）。

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

## agent-providers#11 — 登入成功後在跑的 `copilot --acp` 是否讀得到新憑證，是 field-test open item  ·  [Gotcha]

**現況（copilot = ACP backend 後）**：原本「native SDK 的常駐 `CopilotClient` runtime 在登入前 spawn 即無 auth、登入後不重讀憑證,要丟棄 `state.client` 重 spawn」這條 —— **隨 SDK backend 一起刪除、不再適用**（ACP 沒有常駐 SDK client）。

**但相同性質的疑慮可能仍在（未驗證,field-test 觀察）**：`copilot --acp` 進程在 caps 時就 spawn（可能早於登入）;in-app device-login 把憑證寫進 `COPILOT_HOME` 後,**正在跑的那顆 --acp 進程是否會重讀 config-home 的新 auth,還是要重生連線?** 目前連線只在 **appId 變更**時重生(`agent-providers#15`),**登入不觸發重生**。若 CLI 不 mid-process 重讀 → 登入後首個 turn 可能仍認證失敗,需要一個「登入成功 → 重生連線」的動作。**確認前別假設沿用即可用。**

**Related**：`agent-providers#10`（device-flow 登入主流程,ACP 沿用）、`agent-providers#15`（appId 變更才重生連線）、`agent-server/providers/copilot/index.ts`（`startLogin`）。

## agent-providers#12 — Headless remote：貼 `GH_TOKEN` secret env 就能認證 Copilot（不靠 `copilot login`）  ·  [Decision]

**背景**：無瀏覽器/無 OS credential store 的 headless remote 上，`copilot login`（device flow）存不了憑證（沒有 Secret Service），`gh` 也常沒裝 → device-flow 這條走不通。

**Decision（copilot = ACP backend 後）**：使用者把 `GH_TOKEN`/`GITHUB_TOKEN` 貼成**專案 Secret env var**（見 `context/project-env`）→ Shelf 注入 agent-server env → `copilot --acp` 進程**繼承**這個 env（Shelf spawn 時帶 `{...process.env, COPILOT_HOME}`）→ **CLI 自己讀 token env 認證**。Shelf **不再有** token 注入 code（原 `readGhToken`/`buildCopilotAuthConfig`/`copilotTokenFromEnv` 隨 SDK backend 刪除）—— token-env 現在純由 CLI 端處理。（互動 `copilot login` 才會 `scrubLoginEnv` 剝掉這些 token 強走瀏覽器,見 `agent-providers#10`;`--acp` run 不剝 → 憑 env 認證。）

**Reason**：官方 CLI 文件明講 headless 用 token env var。這把「remote 存不了憑證」從死路變成「貼個 secret token」,復用 project secret env（加密、不同步）,守 `agent-providers#15` 的「不承攬憑證」（只讓使用者自管的靜態 token 經 env 傳給 CLI,Shelf 不 parse）。

**Related**：`context/project-env`（secret env 儲存/注入）、`agent-providers#15`（device-scoped auth / token 正交）、`agent-server/providers/copilot/helpers.ts`（`copilotAcpEnv` 帶 env）。

## agent-providers#13 — Copilot + Codex 走 ACP（`copilot --acp` / codex-acp）+ 共用 `acp/` toolkit；ACP 是「有官方 ACP 的 provider」的基準  ·  [Decision]

**Decision**：非-Claude 的 agent provider 走 **Agent Client Protocol (ACP)** — Shelf 是 ACP **client**，spawn provider 的 ACP server（copilot 官方直出 `copilot --acp`；codex 走 `@agentclientprotocol/codex-acp` 包 codex CLI），per-tab 一條連線。Provider→wire 的翻譯（tool 對相關、event 過濾、streaming 組裝）收進**共用 `acp/` toolkit**（`connection`/`client`/`translate`/`permission`/`capabilities`），copilot 與 codex backend 都是它的 consumer；各 backend 只剩自家語意（mode-map、auth、launch cmd、skill target）。

**Reason / verdict（spike 結論）**：
- **已證（N=2）**：ACP 收束 provider→wire 翻譯 —— 免掉整套 SDK-specific correlation/filtering/streaming（copilot backend ≈ 420 LOC vs 已刪的 native SDK backend 2,751 LOC）。第二個 consumer（copilot）逼出真正的 toolkit 層界。
- **未證（要 N=3 才驗）**：「ACP 讓每個 provider 整合都便宜」。① 整合 + ② 硬化 toolkit 因果不可分（②只在做①時才發現）；per-provider 成本低要到成熟 toolkit 接第 3 個 provider 才驗得到。
- **ACP 不是萬用便宜（誠實反例）**：(a) Shelf built-in MCP bridge 在 claude 是幾行 `createSdkMcpServer`，在 ACP 要架真 in-process HTTP MCP server（重）。(b) **skill 注入退化**：native SDK 有 per-session skill 欄位，ACP `NewSessionRequest` 沒有 → 被逼進 config-home + 重登（見 `skills`）。(c) **使用者 stdio MCP 退化**（copilot 上游 bug，見 `mcp`）。—— 抵銷面：ACP 讓 `/mcp` `/skills` 原生派發，`skills#3` 那套攔截對 ACP provider 可移除。
- **DIRECTION**：ACP 是**「CLI 有官方 ACP mode」的 provider 的基準**（盡可能，非全面）。copilot ✓、codex ✓；**claude 例外** —— 它唯一的 ACP surface 是第三方 SDK-wrapper adapter（Anthropic 只出 Agent SDK，`claude acp serve` 上游 closed「not planned」），高成本低效益 → claude 留在 Agent SDK。ACP-as-baseline = 新的「官方直出 ACP」provider 的預設,不是回頭硬遷既有的。

**Do not change casually because**：別把 copilot/codex 的 ACP 翻譯邏輯搬回各 backend —— 那正是 toolkit 收束掉的東西,重複=回到 per-provider 各寫一套。別為了「統一」把 claude 也硬推 ACP（第三方 adapter、N sessions=N procs、無官方 ACP）。

**Related**：`agent-providers#14`（prior-art 方法論）、`skills`/`mcp`（ACP 帶來的 skill/MCP 差異）、`agent-server/providers/acp/*`、`agent-server/providers/{copilot,codex}/index.ts`。

## agent-providers#14 — 整合新 provider/能力：先查 prior art（agent 官方 docs → Zed → SDK types），別從「標準說 X」推  ·  [Decision]

**Decision**：接一個新 provider 或新能力時,查證順序固定:(1) 該 agent 自己的官方 docs;(2) **已整合它的 reference client（尤其 Zed —— ACP 的 reference 實作）**;(3) SDK types/examples。**這三步之後才自己 probe/猜**。

**Reason**：這次 spike 每個走錯的彎（猜 MCP-over-ACP `mcp/*` tunnel、猜 skill `additionalDirectories`、messageId/URL-mode 假設、stdio MCP command 是不是絕對路徑）**全部來自「上層標準說 X,所以 agent 一定做 X」**,而不是「這個 agent / Zed 實際上怎麼做」。**agent 本身 + 它的 reference 整合才是 source of truth,不是上層協定標準。** ACP schema 說 `McpServerStdio.command` 是「absolute path」不代表 copilot 會照做/會 PATH 解析 —— 唯一可信的是實測 copilot 或看 Zed 怎麼送。

**Do not change casually because**：別把「協定/SDK 文件這樣寫」當成 agent 一定這樣實作 —— 兩者常有落差,以 agent 實測/reference client 為準。

**Related**：`agent-providers#13`、`mcp`（#1040 stdio 就是靠查上游 issue 定位,不是靠 probe）。

## agent-providers#15 — Provider auth = device-scoped：per-appId config-home ENV 隔離 device-login；token-env 正交  ·  [Decision]

**Decision**：provider 的 device-login 憑證按 **appId 隔離**,方法是把 CLI 的 config-home ENV 指到 per-app 目錄:copilot `COPILOT_HOME`、codex `CODEX_HOME`、（未來）claude `CLAUDE_CONFIG_DIR` → `~/.shelf/apps/<appId>/{copilot,codex,claude}`。**env 要同時設在 `login` 與 run（`--acp` spawn）兩處**。因為 config-home 是行程 env、spawn 當下固定,而 appId 到 `get_capabilities` 才第一次已知（見 `contracts`）→ appId 要 thread 進 caps,且 appId 變更要重生連線。

**Reason**：provider auth 本質是 **device-scoped**（GitHub device-flow / codex device-code 授權的是一台裝置）。remote 上**一組 appId 就是一台 device**（一個 install/client）→ 按 appId 隔離 = 讓 auth 邊界對齊 device 邊界,語意正確,非防禦性 hack。**多租戶正確**:一台 remote 服務多個 client（不同 appId/帳號）,共用 `~/.<cli>` 會撞 auth。「一次性重登」不是 regression,是**正確的一次 device 授權**（Shelf 是它自己的 device;使用者 terminal 的 `~/.<cli>` 是另一個 device-context,不該默默沿用）。守 `agent-providers#12` 原意「不承攬憑證」= 不 parse/copy auth 內容;**ENV 改 config dir 是給路徑,不算承攬**（複製憑證檔才算,已否決）。

**token 路徑正交**：帳號級 TOKEN env（copilot `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`、`ANTHROPIC_API_KEY`）不受 home 隔離 —— 它注入帳號憑證、短路 device-login,跨 device 生效（`copilot/login.ts` 的 `scrubLoginEnv` 就在互動登入時剝掉它們免短路）。home-env 隔離的是 **device-login store**;token-env 是獨立的帳號 override。兩者並存不衝突。

**claude 例外（已知、非平凡的未來 migration）**：claude auth 是 `sdk-managed`、現在靠 **ambient `~/.claude`**（AuthPane 叫使用者去 terminal 跑 `claude login`,**無 in-app login flow**）。套 device 模型到 claude 會 (a) 打破 ambient 沿用 (b) 要重做 auth UX (c) 撞 `CLAUDE_CONFIG_DIR` 弱連結（未文件化）。只有 OAuth 路徑受影響（`ANTHROPIC_API_KEY` = 正交 token 路徑）→ 獨立的未來工作,claude 現況刻意留 ambient（odd-one-out）。

**Do not change casually because**：別只在 run 設 config-home 而漏了 login（憑證會寫錯目錄）;別以為 appId 在 caps 前就有（要 thread 進 `get_capabilities`,否則 caps-time spawn 拿不到 home）;別把 device-home 隔離跟 token-env 混為一談。

**Related**：`agent-providers#12`（token-env headless）、`agent-providers#10`（copilot device-login 流程,ACP 沿用同一份）、`contracts`（appId 進 caps）、`agent-server/providers/{copilot,codex}/helpers.ts`（`*ConfigHome`/`*AcpEnv`）。

## agent-providers#16 — Provider backend = 純 SDK/CLI adapter；provider 目錄互相孤立  ·  [Decision]

**Decision（兩條互補的界線）**：
- **provider = 純 SDK/CLI adapter**：backend 只負責跟自己的 SDK/CLI 對話（`session/new`、`prompt`、`set_mode`、device-login）。**任何非-SDK/CLI 的事 —— fs、路徑/投影、跨切面協調 —— 都是外部,要委派**:emit 給 agent-server,或交給 agent-server 擁有的 shared func。**provider 自己絕不碰 fs。** 現存 conformant 例:`loadProjectedMcpServers`、`getShelfMcp`、skill 投影（provider 只宣告 `skillTarget`,agent-server 執行 `projectAppSkills` —— 見 `skills`）。
- **provider 目錄互相孤立**：一個 provider 目錄**不 import 另一個 provider 的內部檔**。真正跨 provider 共用的邏輯**抽成 shared 模組**（`acp/` toolkit、`providers/shared.ts`、`mcp-config`…）,不伸手進別人目錄。新 provider 一律做成自足;要共用先抽出來。

**Reason**：這是 CLAUDE.md「renderer 三機制職責」精神下移一層到 provider。fs/投影收到中央 = 冪等/原子/去重只做一次、無跨進程 race（見 `skills` 的 `projectAppSkills`）;provider 只碰 SDK/CLI = 職責單一、好測、換 provider 不牽動 fs 邏輯。目錄孤立 = 刪/換一個 provider 是整包操作,不用回頭查它伸手進了誰。（反例已修:copilot-acp 曾 import `copilot/login`,cutover 時把 login 移進 copilot 目錄它該屬的地方。）

**Do not change casually because**：別在 provider backend 直接寫 fs（symlink/mkdir/rm）—— 交給 shared func;別讓 provider A import provider B 的檔（要共用就抽 shared 模組,否則刪 B 會炸 A）。

**Related**：`agent-providers#1`、`skills`（skill 投影權責:provider 宣告 / agent-server 執行）、`agent-server/providers/{shared.ts,acp/*}`。

## agent-providers#17 — Permission mode 整合政策：native mode 映射到 Shelf 詞彙,可映射全暴露,不可映射 hide+log  ·  [Decision]

**Decision**：各 provider 的原生 permission mode **映射到 Shelf 的 canonical 詞彙**（`default`/`plan`/`acceptEdits`/`bypassPermissions`）。一個 provider **暴露它所有「可映射」的原生 mode**（清單本就 per-provider 變動 —— claude 4 個含 `acceptEdits`,copilot/codex 各 3 個）;**對不上任何 Shelf mode 的原生 mode → hide + fail-loud log**（那是「該不該新增一個 Shelf mode」的討論觸發點,前例:`acceptEdits` 就是為 claude 加的）。displayName 一律走中央 `PERMISSION_MODES` 單一來源（per-provider「誠實副標」如 `Plan (read-only)` 考慮過但**否決** —— 會跟中央化 displayName 打架）。

具體 mode-map（`<provider>/mode-map.ts`,per-provider）:copilot `agent/plan/autopilot` ↔ `default/plan/bypassPermissions`;**codex `read-only/agent/agent-full-access`（查自 codex-acp `AgentMode.ts`）↔ `plan/default/bypassPermissions`**（`plan↔read-only` 是唯一判斷 —— read-only = 不自主寫 = 最接近 plan 的安全桶）。permission mode 清單**從 session 實際 advertise 的 modes 推導**再映射,不寫死。

**Reason**：承 `agent-providers#4`（permission 語意收進 provider）+ `agent-providers#1`（renderer 對 provider 無感）。統一詞彙 → 一致 UX、可攜設定、固定 keybinding;「可映射才暴露、不可映射 hide+log」= 既不吃掉 provider 能力、也不默默丟失資訊。displayName 中央化 = app-wide UX 一致（同 `agent-providers#4` companion）。

**Do not change casually because**：別讓 provider 自訂 displayName（破壞中央 `PERMISSION_MODES` 一致性）;別對不上就默默丟(要 log,才知道要不要新增 Shelf mode)。

**Related**：`agent-providers#4`（permission 語意 + `PERMISSION_MODES`）、`agent-server/providers/{copilot,codex}/mode-map.ts`、`agent-server/providers/acp/capabilities.ts`。

## agent-providers#18 — Provider 清單單一來源:`AGENT_PROVIDERS` registry,型別 derive,消費端一律 iterate  ·  [Decision]

**Decision**：全部 agent provider 收進單一 registry `src/shared/agent-providers.ts` `AGENT_PROVIDERS = { <id>: { label, bin } }`（`bin` = remote deploy 要 ship 的 self-contained CLI:claude/copilot,codex `null` = 另法部署）。`AgentProvider` 型別 = `keyof typeof AGENT_PROVIDERS`(derive,不另寫 union)。所有消費端 **iterate registry**:New-tab 選單（`TabBar`）、project-config 預設 provider select（`ProjectEditPanel`）、remote deploy binary（`remote.ts` 讀 `.bin`）、agent-server dispatch（`exec.ts` 用 exhaustive `Record<AgentProvider, factory>` —— 漏接一個 compile error）。**無 gating 欄位** —— 尚未 GA 的 provider 在自己 `label` 標 `· dev`,到處都顯示（production 曝光可接受,label 表明、CLI 缺就 spawn 時 fail-loud）。加一個 provider = registry 加一筆 + 一個 backend factory。

**Reason**：加 codex + ACP 時發現「provider 集合」原本硬編在 ~6 處且**已 diverge**（project-config select 漏 2 個 provider;`remote.ts` 把 acp-copilot 錯配成 claude binary）。收進 registry + 型別 derive → 加/改一處全自動,不會漏。承 CLAUDE.md「跨檔重複值用具名 const、型別從常數 derive」。

**Do not change casually because**：別再在別處硬編 provider 清單或 `provider === 'x'` 的分支去做 dispatch/選單/部署 —— 一律從 registry 來,否則又會 diverge。

**Related**：CLAUDE.md Conventions、`agent-providers#1`、`src/shared/agent-providers.ts`、`agent-server/exec.ts`、`src/main/agent/remote.ts`、`src/renderer/components/{TabBar,ProjectEditPanel}.tsx`。

## agent-providers#19 — ACP tool-call update 是 partial:title 要在 provider 層 carry-forward,別讓 title-less update 覆蓋成 `Tool`  ·  [Gotcha]

**Symptom**：Copilot（及任何 ACP provider）的工具卡片全部顯示成無意義的 `Tool`,原本的工具標題（如 `Grep`/`Edit file.ts`）不見了。

**Root cause**：ACP 的 `tool_call`（初次）`title` **必填**,但 `tool_call_update`（帶 status/結果的後續）是 **partial update** —— `title` optional,未給即「不變」。而 Shelf wire 的 `message` 是 **full upsert-by-msgId**(renderer `agentTabStore.upsertById` 依 `msgId=toolCallId` **整個覆蓋** card)。所以帶結果卻沒 title 的 update 一旦 translate 落到 `label:'Tool'` fallback,就把初次的好標題蓋掉。

**Fix / note**：在 **agent-server 的 ACP 層**還原 partial 語意(provider 封裝 provider 語意,renderer 維持 dumb full-replace)——`translate.ts` 的 `createToolMetaCarry()` 每個 turn 建一次,記住每個 `toolCallId` 最後看到的 title,對後續 update 重新注入;`client.ts drivePromptTurn` 在 `translateSessionUpdate` 前先過這個 carry。**不要**改成讓 renderer store 做 partial merge —— 那會把 ACP 語意洩漏進 renderer、且動到所有 provider/訊息型別的 upsert。

## agent-providers#20 — ACP 工具卡片:`kind` → 短 label(粉紅工具名)、`title` → subtitle(灰色描述),對齊 claude 的 label/subtitle 語意  ·  [Decision]

**Decision**：ACP tool_call 的 wire 卡片 **`label` = `kind` 對應的短工具名**（`read`→`Read`、`search`→`Search`、`execute`→`Execute`…；`other`/缺 → 泛用 `Tool`），**`subtitle` = `title`（copilot 的描述句，如「Viewing …file」「Searching for '…'」）**。對應 `translate.ts` 的 `TOOL_KIND_LABELS` / `toolKindLabel()`。

**Reason**：這對齊 claude provider 的槽位語意——`label`（渲染成**粉紅**的主標）= **短工具名**（`Read`/`Edit`/`Bash`）、`subtitle`（灰色副標）= **目標/描述**（`stripCwd(file_path)` / input args）。copilot 的 `title` 是「動作＋目標」揉成的**長句**;若把整句塞進 `label`,一整欄粉紅長字**難以聚焦閱讀**。改用短 `kind` 當 label、長 `title` 退到 subtitle,一欄短標籤好掃視,細節在灰字。

**Do not change casually because**：(a) 別把 `title` 放回 `label`——會回到「一片粉紅長句」的難讀狀態。(b) copilot 的 `kind` **不可靠**（它把 search 標成 `other`），所以 `other`/缺一律落 `Tool`,不要假設 kind 一定精準。(c) `kind` 純驅動 label 文字,**不決定** fold_diff/fold_code（那由 `firstDiff(content)` 判）。

### Gotchas
- ACP `tool_call_update` 是 **partial**（省略 title/kind = 不變），但 wire `message` 是 full upsert（renderer 依 msgId 整個覆蓋 card）→ 沒 carry 就會把 label/subtitle 清成預設。`createToolMetaCarry()` 每 turn 記住 `toolCallId` 的 title+kind 並回填後續 update（見 `#19`）。

**Related**：`agent-server/providers/acp/{translate,client}.ts`、`agent-server/providers/claude/index.ts`（`subtitle` 慣例）、`src/renderer/components/AgentMessage.tsx`（`FoldHeader` label+subtitle）、`contracts/agent-wire-protocol`。

## agent-providers#21 — messageId-less ACP 文字用「工具邊界」切段(mirror Zed),否則一個 turn 的文字折疊成一張早期卡  ·  [Decision]

**Background/Symptom**：copilot `--acp` **省略 `agent_message_chunk.messageId`**（ACP 唯一的訊息邊界訊號;spec 對「省略時」無 fallback,見官方 message-id RFD）。原本 Shelf 把 messageId-less 文字整個 turn namespace 成單一 `sessionId#turnSeq:text` → 一個 turn 內**所有**助理文字(開場 + 工具後的收尾)全落同一張卡、釘在最早位置 → 收尾摘要被併到頂端,底部只剩工具卡,像「沒有結尾訊息」。

**Decision**：在 `client.ts drivePromptTurn` 用 **tool 邊界切段**——文字之後出現 `tool_call`(wire `message`)就 `seg++`,下一段文字換新 id `sessionId#turnSeq:text:<seg>`(text/thinking 共用 seg)。**Mirror Zed 參考 client** 的 `push_assistant_content_block`:上一筆是 assistant message 才 append、是 ToolCall 就開新 entry。每段文字各自成卡、落在自己的時序位置。

**Do not change casually because**：ACP 沒有「訊息完成」旗標(`ContentChunk` 只有 content/messageId/_meta;`stopReason` 是 turn 級),tool 邊界是唯一可靠的推斷。agent 若**有**送 messageId(codex)則 `namespaced` 直接用真 id、不套切段,別破壞那條路徑。

## agent-providers#22 — reconnect 排序用「發起時間」:`upsertMessage` 必須持久化 upsertById 保留後的 timestamp,不是原始 msg  ·  [Gotcha]

**Symptom**：live 順序正確,但 disconnect→reconnect 後,一個 turn 的所有 reply **全擠到最後**(過了交錯的工具卡),時序跑掉。

**Root cause**：卡片的正確排序時間是**發起時間**(工具 = 初次 `tool_call`;文字 = 初次串流,`flushChunkBuffer` 建卡時 `Date.now()`)。`upsertById` 在**記憶體**保留這個早 timestamp(finalize/completed 替換時 `next[i]={...built, timestamp: prev[i].timestamp}`)→ live 正確。但 `upsertMessage` 的 `markDirty` 原本存的是**原始 `msg`**(buildAgentMsg 的 finalize-time `Date.now()`,晚)→ IDB 存成「結束時間」→ reload 依 `by-session-time` 重排就用了結束時間。

**Fix / note**：`upsertMessage` 改成 `markDirty(tabId, tabs.get(tabId).messages.find(id))`——持久化**記憶體裡保留後(發起)的** timestamp。原則:**訊息/工具一律以發起時間排序**;任何「替換既有卡」的持久化都要存保留後的版本,別存新 msg 的時間。

## agent-providers#23 — copilot read/view 內容在 `rawOutput`(非 `content`);完成但無輸出的工具要標 settled,避免 reload 誤判 orphan  ·  [Gotcha]

**Symptom**：(a) Read/Viewing 工具卡片內容空白;(b) reconnect 後這些卡片被標紅 `Session ended before completion`。

**Root cause**：copilot 的 read/view 把檔案內容放 **`rawOutput`**(`{content: "..."}`),**不是** ACP 標準 `content` 陣列;translate 原本只讀 `content` → 內容被丟掉、卡片無 body。而 renderer reload 的 `reviveOrphanPending`(`storage/agent-history.ts`)把「無 body 且無 errorMessage」的 fold 卡片當成**崩潰在半途的 in-flight 工具** → 補 `Session ended before completion`。

**Fix / note**：`translate.ts` `rawOutputToText()` —— `content` 為空時 fallback 抓 `rawOutput`(handle `{content}` copilot / `{formatted_output}` codex / 純字串)。另:`status==='completed'` 但仍無文字的工具,**送空 body `{content:''}`** 標記 settled(reload 就不誤判);renderer `AgentMessage` fold_code 對**空 content 不渲染空灰條**。in-flight(pending/in_progress)仍保持無 body → 真崩潰照樣被 reload 標出。

## agent-providers#24 — copilot 用 `task_complete` 工具送最終總結:translate 特判成結尾 `reply`,不是埋在工具卡  ·  [Decision]

**Decision**：`translate.ts` 特判 `title==='task_complete'`(靠 `createToolMetaCarry` 帶過來的 title)—— 有內容 → 渲染成 `reply`(markdown 結尾發言,因是該 turn 最後動作故落在最底);裸訊號(無內容)→ 不顯示。

**Reason**：copilot 的 agent 用 `task_complete` 工具自我宣告完成、把**最終總結放在它的 content/rawOutput**,而非純文字(ACP 的完成訊號是 turn 級 `stopReason`,agent 只好借工具送結尾訊息)。若當普通工具渲染,總結會埋在收合的「Tool」卡裡。

**Do not change casually because**：這是 **copilot title 慣例的特判、非 ACP 標準**(Zed 等參考 client 不特判,一律當普通工具);copilot 改名就失效。屬 Shelf 專屬加值,發現顯示問題(如與前面文字重複)再議。
