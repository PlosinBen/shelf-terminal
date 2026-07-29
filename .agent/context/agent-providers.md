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

**Decision**：像 `/mcp` `/skills` 這種「列出 session 載入了什麼」的輸出,**每個 provider 用自己的 runtime shape 直接組 markdown**(渲染原語)再 `reply` 出去。**不**先把各家資料 normalize 成一個跨 provider 的共通結果型別。Claude 使用 SDK shape；Codex 使用 app-server list routes；Copilot ACP 由 CLI 原生派發。共通層只保留無語意的排版工具。

**Reason / 為什麼**:共通 result type 是**最低公分母契約** —— 各家資料天生不對稱(Claude `mcpServerStatus().tools` 帶 per-server tools + `readOnly`/`destructive` annotations;Copilot 的 `mcp_servers_loaded` / `mcp.list()` / `mcp.discover()` 三者都**沒有** per-server tools),硬塞進共通型別只能靠一堆 optional 欄 + adaptive column 撐,愈加愈漏。更糟的是**權責倒置**:把「怎麼呈現」的責任從各 provider 上收到共通層,等於逼共通層去懂每一家的 quirks,新 provider 進來得先滿足這個型別 → 不利擴充。承 `agent-providers#1`(差異封裝在 provider 內)+ CLAUDE.md「wire 給 renderer 的是渲染原語,不是 provider 語意」:呈現本就是 per-provider 的事,直接在 provider 內組 md 最誠實。

**結果**：Claude與Codex各自產生 provider-owned輸出，Copilot CLI原生輸出；renderer只接收渲染原語，不知道來源 transport。

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

## agent-providers#13 — ACP toolkit 服務官方 ACP provider；目前 production consumer 是 Copilot  ·  [Decision]

**Decision**：Shelf 的 ACP client/translation toolkit 保持 provider-agnostic，供官方直接提供 ACP mode 的 provider 使用；目前 production consumer 是 `copilot --acp`。Codex 改走官方 app-server JSON-RPC，Claude 保持官方 Agent SDK。

**Reason**：協定共用只在 provider 真正採 ACP 時成立。Copilot 仍需要 connection/client/translation/permission/capabilities 與 Shelf MCP bridge；Codex app-server 提供更完整的 thread/control/context/account surface，不應為了重用 toolkit 而退回第三方 ACP adapter。

**Do not change casually because**：不要移除 Copilot 仍使用的 shared ACP toolkit；也不要為表面一致把 Codex 或 Claude 強制包回 ACP。選擇 transport 要以 provider 官方、完整的 runtime surface 為準。

**Related**：`agent-providers#14`、`agent-providers#33`、`skills`、`mcp`、`agent-server/providers/acp/*`。

## agent-providers#14 — 整合新 provider/能力：先查 prior art（agent 官方 docs → Zed → SDK types），別從「標準說 X」推  ·  [Decision]

**Decision**：接一個新 provider 或新能力時,查證順序固定:(1) 該 agent 自己的官方 docs;(2) **已整合它的 reference client（尤其 Zed —— ACP 的 reference 實作）**;(3) SDK types/examples。**這三步之後才自己 probe/猜**。

**Reason**：這次 spike 每個走錯的彎（猜 MCP-over-ACP `mcp/*` tunnel、猜 skill `additionalDirectories`、messageId/URL-mode 假設、stdio MCP command 是不是絕對路徑）**全部來自「上層標準說 X,所以 agent 一定做 X」**,而不是「這個 agent / Zed 實際上怎麼做」。**agent 本身 + 它的 reference 整合才是 source of truth,不是上層協定標準。** ACP schema 說 `McpServerStdio.command` 是「absolute path」不代表 copilot 會照做/會 PATH 解析 —— 唯一可信的是實測 copilot 或看 Zed 怎麼送。

**Do not change casually because**：別把「協定/SDK 文件這樣寫」當成 agent 一定這樣實作 —— 兩者常有落差,以 agent 實測/reference client 為準。

**Related**：`agent-providers#13`、`mcp`（#1040 stdio 就是靠查上游 issue 定位,不是靠 probe）。

## agent-providers#15 — Provider auth = device-scoped：per-appId config-home ENV 隔離 device-login；token-env 正交  ·  [Decision]

**Decision**：provider 的 device-login 憑證按 **appId 隔離**,方法是把 CLI 的 config-home ENV 指到 per-app 目錄:copilot `COPILOT_HOME`、codex `CODEX_HOME`、（未來）claude `CLAUDE_CONFIG_DIR` → `~/.shelf/apps/<appId>/{copilot,codex,claude}`。Env 必須同時設在 login 與 runtime spawn（Copilot `--acp`、Codex `app-server`）。因為 config-home 是行程 env、spawn 當下固定,appId 變更要重生連線。

**Reason**：provider auth 本質是 **device-scoped**（GitHub device-flow / codex device-code 授權的是一台裝置）。remote 上**一組 appId 就是一台 device**（一個 install/client）→ 按 appId 隔離 = 讓 auth 邊界對齊 device 邊界,語意正確,非防禦性 hack。**多租戶正確**:一台 remote 服務多個 client（不同 appId/帳號）,共用 `~/.<cli>` 會撞 auth。「一次性重登」不是 regression,是**正確的一次 device 授權**（Shelf 是它自己的 device;使用者 terminal 的 `~/.<cli>` 是另一個 device-context,不該默默沿用）。守 `agent-providers#12` 原意「不承攬憑證」= 不 parse/copy auth 內容;**ENV 改 config dir 是給路徑,不算承攬**（複製憑證檔才算,已否決）。

**token 路徑正交**：帳號級 TOKEN env（copilot `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`、`ANTHROPIC_API_KEY`）不受 home 隔離 —— 它注入帳號憑證、短路 device-login,跨 device 生效（`copilot/login.ts` 的 `scrubLoginEnv` 就在互動登入時剝掉它們免短路）。home-env 隔離的是 **device-login store**;token-env 是獨立的帳號 override。兩者並存不衝突。

**claude 例外（已知、非平凡的未來 migration）**：claude auth 是 `sdk-managed`、現在靠 **ambient `~/.claude`**（AuthPane 叫使用者去 terminal 跑 `claude login`,**無 in-app login flow**）。套 device 模型到 claude 會 (a) 打破 ambient 沿用 (b) 要重做 auth UX (c) 撞 `CLAUDE_CONFIG_DIR` 弱連結（未文件化）。只有 OAuth 路徑受影響（`ANTHROPIC_API_KEY` = 正交 token 路徑）→ 獨立的未來工作,claude 現況刻意留 ambient（odd-one-out）。

**Do not change casually because**：別只在 run 設 config-home 而漏了 login（憑證會寫錯目錄）;別以為 appId 在 caps 前就有（要 thread 進 `get_capabilities`,否則 caps-time spawn 拿不到 home）;別把 device-home 隔離跟 token-env 混為一談。

**Related**：`agent-providers#12`、`agent-providers#10`、`contracts`、`agent-server/providers/copilot/helpers.ts`、`agent-server/providers/codex-shared/runtime.ts`。

## agent-providers#16 — Provider backend = 純 SDK/CLI adapter；provider 目錄互相孤立  ·  [Decision]

**Decision（兩條互補的界線）**：
- **provider = 純 SDK/CLI adapter**：backend 只負責跟自己的 SDK/CLI 對話（`session/new`、`prompt`、`set_mode`、device-login）。**任何非-SDK/CLI 的事 —— fs、路徑/投影、跨切面協調 —— 都是外部,要委派**:emit 給 agent-server,或交給 agent-server 擁有的 shared func。**provider 自己絕不碰 fs。** 現存 conformant 例:`loadProjectedMcpServers`、`getShelfMcp`、skill 投影（provider 只宣告 `skillTarget`,agent-server 執行 `projectAppSkills` —— 見 `skills`）。
- **provider 目錄互相孤立**：一個 provider 目錄**不 import 另一個 provider 的內部檔**。真正跨 provider 共用的邏輯**抽成 shared 模組**（`acp/` toolkit、`providers/shared.ts`、`mcp-config`…）,不伸手進別人目錄。新 provider 一律做成自足;要共用先抽出來。

**Reason**：這是 CLAUDE.md「renderer 三機制職責」精神下移一層到 provider。fs/投影收到中央 = 冪等/原子/去重只做一次、無跨進程 race（見 `skills` 的 `projectAppSkills`）;provider 只碰 SDK/CLI = 職責單一、好測、換 provider 不牽動 fs 邏輯。目錄孤立 = 刪/換一個 provider 是整包操作,不用回頭查它伸手進了誰。（反例已修:copilot-acp 曾 import `copilot/login`,cutover 時把 login 移進 copilot 目錄它該屬的地方。）

**Do not change casually because**：別在 provider backend 直接寫 fs（symlink/mkdir/rm）—— 交給 shared func;別讓 provider A import provider B 的檔（要共用就抽 shared 模組,否則刪 B 會炸 A）。

**Related**：`agent-providers#1`、`skills`（skill 投影權責:provider 宣告 / agent-server 執行）、`agent-server/providers/{shared.ts,acp/*}`。

## agent-providers#17 — Permission mode 整合政策：native mode 映射到 Shelf 詞彙,可映射全暴露,不可映射 hide+log  ·  [Decision]

**Decision**：各 provider 的原生 permission mode **映射到 Shelf 的 canonical 詞彙**（`default`/`plan`/`acceptEdits`/`bypassPermissions`）。一個 provider **暴露它所有「可映射」的原生 mode**（清單本就 per-provider 變動 —— claude 4 個含 `acceptEdits`,copilot/codex 各 3 個）;**對不上任何 Shelf mode 的原生 mode → hide + fail-loud log**（那是「該不該新增一個 Shelf mode」的討論觸發點,前例:`acceptEdits` 就是為 claude 加的）。displayName 一律走中央 `PERMISSION_MODES` 單一來源（per-provider「誠實副標」如 `Plan (read-only)` 考慮過但**否決** —— 會跟中央化 displayName 打架）。

具體映射由 transport 各自擁有：Copilot ACP 的 `agent/plan/autopilot` ↔ `default/plan/bypassPermissions` 由 mode-map 依 session advertise 值解析；Codex app-server 把 Shelf mode 映成 thread/turn 的 approval policy 與 sandbox policy，其中 `plan` 是 read-only、`bypassPermissions` 是 full-access。

**Reason**：承 `agent-providers#4`（permission 語意收進 provider）+ `agent-providers#1`（renderer 對 provider 無感）。統一詞彙 → 一致 UX、可攜設定、固定 keybinding;「可映射才暴露、不可映射 hide+log」= 既不吃掉 provider 能力、也不默默丟失資訊。displayName 中央化 = app-wide UX 一致（同 `agent-providers#4` companion）。

**Do not change casually because**：別讓 provider 自訂 displayName（破壞中央 `PERMISSION_MODES` 一致性）;別對不上就默默丟(要 log,才知道要不要新增 Shelf mode)。

**Related**：`agent-providers#4`、`agent-server/providers/copilot/mode-map.ts`、`agent-server/providers/codex/config.ts`、`agent-server/providers/acp/capabilities.ts`。

## agent-providers#18 — Provider 清單單一來源:`AGENT_PROVIDERS` registry,型別 derive,消費端一律 iterate  ·  [Decision]

**Decision**：全部 agent provider 收進單一 registry `src/shared/agent-providers.ts` `AGENT_PROVIDERS = { <id>: { label, bin } }`。`label` 是正式使用者可見顯示名；`bin` 是 exhaustive remote deploy selector：Claude/Copilot 對應單一 shipped binary，Codex=`codex` 觸發其完整 target runtime tree（見 `deployment#7`）。`AgentProvider` 型別 = `keyof typeof AGENT_PROVIDERS`(derive,不另寫 union)。所有消費端 **iterate registry**:New-tab 選單（`TabBar`）、project-config 預設 provider select（`ProjectEditPanel`）、remote deploy binary（`remote.ts` 讀 `.bin`）、agent-server dispatch（`exec.ts` 用 exhaustive `Record<AgentProvider, factory>` —— 漏接一個 compile error）。**無 gating 欄位** —— registry membership 代表 provider 到處都顯示；runtime/CLI 缺失在 spawn 時 fail-loud。加一個 provider = registry 加一筆 + 一個 backend factory。

**Reason**：加 codex + ACP 時發現「provider 集合」原本硬編在 ~6 處且**已 diverge**（project-config select 漏 2 個 provider;`remote.ts` 把 acp-copilot 錯配成 claude binary）。收進 registry + 型別 derive → 加/改一處全自動,不會漏。承 CLAUDE.md「跨檔重複值用具名 const、型別從常數 derive」。

**Do not change casually because**：別再在別處硬編 provider 清單或 `provider === 'x'` 的分支去做 dispatch/選單/部署 —— 一律從 registry 來,否則又會 diverge。

**Related**：CLAUDE.md Conventions、`agent-providers#1`、`src/shared/agent-providers.ts`、`agent-server/exec.ts`、`src/main/agent/remote.ts`、`src/renderer/components/{TabBar,ProjectEditPanel}.tsx`。

## agent-providers#19 — ACP tool-call update 是 partial:title 要在 provider 層 carry-forward,別讓 title-less update 覆蓋成 `Tool`  ·  [Gotcha]

**Symptom**：Copilot（及任何 ACP provider）的工具卡片全部顯示成無意義的 `Tool`,原本的工具標題（如 `Grep`/`Edit file.ts`）不見了。

**Root cause**：ACP 的 `tool_call`（初次）`title` **必填**,但 `tool_call_update`（帶 status/結果的後續）是 **partial update** —— `title` optional,未給即「不變」。而 Shelf wire 的 `message` 是 **full upsert-by-msgId**(renderer `agentTabStore.upsertById` 依 `msgId=toolCallId` **整個覆蓋** card)。所以帶結果卻沒 title 的 update 一旦 translate 落到 `label:'Tool'` fallback,就把初次的好標題蓋掉。

**Fix / note**：在 **agent-server 的 ACP 層**還原 partial 語意(provider 封裝 provider 語意,renderer 維持 dumb full-replace)——`translate.ts` 的 `createToolMetaCarry()` 每個 turn 建一次,記住每個 `toolCallId` 最後看到的 title,對後續 update 重新注入;`client.ts drivePromptTurn` 在 `translateSessionUpdate` 前先過這個 carry。**不要**改成讓 renderer store 做 partial merge —— 那會把 ACP 語意洩漏進 renderer、且動到所有 provider/訊息型別的 upsert。

## agent-providers#20 — ACP 工具卡片:`kind` → 短 label(粉紅工具名)、`title` → subtitle(灰色描述),對齊 claude 的 label/subtitle 語意  ·  [Decision]

**Decision**：ACP tool_call 的 wire 卡片 **`label` = `kind` 對應的短工具名**（`read`→`Read`、`search`→`Search`、`execute`→`Execute`…；`other`/缺 → 泛用 `Tool`），**`subtitle` = 影響的檔案路徑（ACP `locations[0].path`,否則 diff block 的 `path`),沒有路徑才退回 `title`**。對應 `translate.ts` 的 `TOOL_KIND_LABELS`/`toolKindLabel()` + `firstDiff().path`/`locations`。

- 檔案路徑優先的原因:copilot 的 edit 工具 `title` 是泛用的 **`apply_patch`**（沒帶檔案),但 ACP 標準欄位 `locations`/diff `path` 有絕對路徑 → 拿它當 subtitle 才對齊 claude（`Edit` → subtitle=`<file path>`）。無檔案的工具（execute/search）沒有 locations → subtitle 退回 `title`（命令/pattern）。

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

## agent-providers#25 — copilot ACP 不 emit `usage_update` → status bar 對 copilot 沒有 ctx / cost / AI-credit（等上游 #4233）  ·  [Gotcha]

**Symptom**：copilot 的 agent status bar 只有 `state | provider | model | mode | effort`,缺 `ctx: NN%` 及其後的 cost / turns / credit（claude 有）。

**Root cause**：`ctx`(context usage)來自 ACP `usage_update`（`translate.ts` 已有 handler,讀 `used`/`size`）。但 **`copilot --acp` 從不 emit `usage_update`**——它認得這個 type（在自己的 ACP schema 裡）卻不送。資料其實存在於 copilot CLI 內部（`/context`、`/usage`、experimental `statusLine.command` 的 `context_window.*`、`aiCreditsUsed/Remaining` 都算好了),只是沒透過 ACP 轉發（parity gap）。`numTurns`/`rateLimits` 則是 **Claude SDK 專屬**、ACP 標準沒有,copilot 本就給不出。

**Fix / note**：**不自己估**——Zed 對 copilot 硬編 128k context window、估錯（[zed#44909](https://github.com/zed-industries/zed/issues/44909)）。已開上游票 [copilot-cli #4233](https://github.com/github/copilot-cli/issues/4233) 要 ACP emit `usage_update`（ctx 走標準 `used`/`size`/`cost`；AI-credit 走 `usage_update._meta`）。**ctx 仍等上游**（修好後自動亮,handler 現成）。**AI-credit 已不等 ACP**：改走 SDK `account.getQuota` 取 account-level premium 額度（見 `#26`）——這是 account 級、跟 session ctx 無關,不需要 #4233。`numTurns`/`rateLimits` 是 Claude SDK 專屬,copilot 給不出。

**Related**：`agent-server/providers/acp/translate.ts`（`usage_update` handler）、`agent-providers#26`（credit via SDK）、`src/renderer/components/agent/StatusBar.tsx`、`UPSTREAM_WATCH.md`。

## agent-providers#26 — copilot account credit 走 SDK `account.getQuota`（config-home auth）+ 每 host cache-aside(15min)+ turn-end 觸發,turnId-less status 送渲染  ·  [Decision]

**Decision**：copilot 的 **account-level AI-credit**（premium requests 用量）不走 ACP,改用 `@github/copilot-sdk` 的 `account.getQuota`。封裝在 `agent-server/providers/copilot/credit.ts`:
- **Fetch**：`new CopilotClient({ connection: RuntimeConnection.forStdio({ path: <shipped copilot bin> }), env: copilotEnv(appId), useLoggedInUser: true })` → `start()` → `rpc.account.getQuota({})` → `stop()`。`normalizeCredit` 取 `quotaSnapshots.premium_interactions` → `StatusSegment`（`premium: used/total (pct%)`,severity 隨剩餘 %;`isUnlimitedEntitlement`/缺欄位 → `null` 不顯示）。
- **Auth = config-home,不碰 token 檔**：`useLoggedInUser:true` + `env.COPILOT_HOME = ~/.shelf/apps/<appId>/copilot`（ACP session 用的同一個 per-app config-home）→ SDK 用 CLI 既有登入態認證,不讀 copilot 私有 token 檔。守住 device-scoped-auth / provider-boundary（`#15`/`#16`）。
- **Cache-aside**：`refreshCopilotCredit` 打 dispatcher 的 per-host cache（`agent-dispatch.md` 的 `ModelCacheClient`）,**TTL 15min**。key = 單一 `account-credit`（**不帶 appId**:一個 host = 一個 config-home = 一個 user)。沒有 dispatcher cache 時退化用 process-local fallback（仍受 TTL 節流）。任何 error → fail-quiet 不顯示。
- **觸發 = turn-end**（無開場 fetch,對齊 claude 首輪後才有 status）。`exec.ts` 在 `backend.query` 後 fire-and-forget `backend.refreshAccountStatus?.(cache, send, appId)`（`ServerBackend` 選配 hook）,用 **base send（turnId-less）**。
- **送渲染**：credit status **不帶 `state`**（status wire `state?` 因此設為選配,避免 credit-only status 誤翻 streaming）。`turn-dispatcher` 特判「turnId-less 的 `status`」→ 走 `onSessionEvent`（session-scoped）→ IPC → store `setStatus` 合併 `credits` → `StatusBar.tsx` 渲染,不進 per-turn generator。

**Reason**：credit 是 account 級、ACP 無標準欄位且 `copilot --acp` 不 emit usage（`#25`）,SDK 是今天唯一乾淨路徑。spawn copilot binary 有成本 → 每 host 15min 一次、turn-end 才查、cache 共用,把 spawn 頻率壓到最低。

**Do not change casually because**：(1) 拿掉「turnId-less status → onSessionEvent」特判,credit status 會因無對應 turn 被丟棄。(2) 把 `state?` 改回必填,credit-only status 會誤觸發 streaming 旁效。(3) cache key 加回 appId 會讓同 host 多 tab 各自 spawn,失去共用。(4) `account.getQuota` 是 `@experimental` → 一定 fail-quiet,別讓它 block turn 或 crash。

**Related**：`agent-server/providers/copilot/credit.ts`、`agent-server/providers/copilot/helpers.ts`（`resolveCopilotBinary`/`copilotEnv`）、`agent-server/exec.ts`、`agent-server/providers/types.ts`（`refreshAccountStatus` hook + `credits`）、`src/main/agent/turn-dispatcher.ts`、`src/renderer/components/agent/StatusBar.tsx`、`architecture/agent-dispatch.md`（per-host cache）。

## agent-providers#27 — streaming caret 維持「單一 active」不變式:flush 時 settle 非當前段,別等 turn-end idle  ·  [Gotcha]

**Symptom**：copilot 一個 turn 內出現多個閃爍光標——每則助理 reply 卡都掛著 caret,而不是只有正在輸出的那則。

**Root cause**：caret 就是 `message.streaming === true` 時渲染的 `.agent-cursor`（`AgentMessage.tsx`）。`streaming` flag 由 `appendChunk`/flush 設 true,但**原本只有 `setStreaming(false)`（turn-end idle）一條路清它,且一次清光**。boundary-split（`#21`）把一個 turn 的文字切成多則各自 msgId 的 chunk-only reply(無 per-segment finalize),中途沒有任何地方 settle 前一段 → 全部撐到 idle 才清 → 多 caret 併存。claude 因單一 msgId 全程同一則、不觸發。

**Fix / note**：在 `flushChunkBuffer`（`agentTabStore.ts`）維持**單一 active caret 不變式**:記住這次 flush 最後寫入的 msgId（buffer 為插入序,末筆＝最新＝ live），迴圈後把其餘仍 `streaming:true` 的 reply/fold_text 就地 `streaming:false` + `markDirty`（在段落邊界就落 IDB,對齊 `setStreaming(false)` 的清理與持久化語意;`appendChunk` 本身刻意不 markDirty,partial 不落盤,所以這裡是唯一寫入點)。**別改回「只在 idle 清」**——會讓 boundary-split 的每段殘留 caret。前提:ACP 邊界只往前走,不回填前一個 msgId(若某 provider 會回填,單一 active 假設要重審)。

**Related**：`src/renderer/agentTabStore.ts`（`flushChunkBuffer` / `setStreaming`）、`src/renderer/components/AgentMessage.tsx`（`.agent-cursor`）、`agent-providers#21`（boundary-split 是成因）。

## agent-providers#28 — Worktree boot provider is an explicit creation-time override  ·  [Decision]

**Decision**：New Worktree dialog 的 provider selector 從 `AGENT_PROVIDERS` registry iterate。Parent default 只有在 registry-valid 時才可預選；missing/unknown default 顯示無選擇並禁止建立，直到使用者明確選一個有效 provider。選擇值只寫到新 child project 的 `defaultAgentProvider`。

**Reason**：讓不同 worktree 可啟動不同 provider，同時維持既有 parent-inheritance 行為與 provider registry 的單一來源。

**Do not change casually because**：不要在 dialog 硬編 provider 名單，或把 selection 回寫 parent；前者會與 registry drift，後者會意外改變既有 project 的新 tab 行為。

## agent-providers#29 — Codex thought chunks may begin with formatting-only blank lines; strip only the leading blank lines  ·  [Gotcha]

**Symptom:** An expanded Codex Thinking card has a visibly empty area before its first thought.

**Root cause:** Codex ACP can prefix an `agent_thought_chunk` with blank lines. Thinking bodies intentionally preserve whitespace so normal prose and paragraph breaks remain faithful; forwarding that prefix therefore creates real rendered height, rather than merely an invisible transport detail.

**Fix / note:** At the ACP-to-wire boundary, remove only leading blank lines from thought chunks before emitting the Thinking stream. Do not trim ordinary assistant messages, tool output, trailing whitespace, or later paragraph breaks: those may carry user-visible formatting.

## agent-providers#30 — 「一個 CLI 服務多 session」是 per-provider 硬差異  ·  [Decision]

**Decision:** Copilot ACP與Codex app-server的底層 CLI protocol都能承載多個 session/thread；Shelf目前仍以 per-session execution隔離它們。Claude不行——Agent SDK的 `query()` 每個對話各自 spawn CLI，resume/fork也會產生新行程。

**Reason：** Shelf 目前「一 tab 一 CLI」對 Copilot/Codex 是 dispatch-layering 的**選擇**（每個 exec 各開自己的 client），不是 SDK 限制——這兩者可把 N 個 tab 收斂到一個 CLI（provider CLI 是記憶體最大宗）。對 Claude 是**硬限制**（一對話一行程），無法共享，只能靠 idle-teardown 之類手段回收。

**Trade-off（CLI 共享未做的原因）：** 共享 CLI = 該 provider 全 tab 共命運——一個 CLI crash 會拖垮它服務的所有 session;dispatch-layering 選 per-session 隔離部分正是為此。省記憶體要拿隔離性換,這是任何 CLI-sharing 設計要先權衡的點。

**Do not change casually because：** 任何「CLI 共享」設計只對 Copilot/Codex 成立；套到 Claude 會違反 SDK 的一行程一對話模型。

## agent-providers#31 — Claude resume/wake 成本由 spawn 主導、與 session 大小無關  ·  [Decision]

**Decision：** Claude resume-to-ready ≈ **~1.5s，且與 session JSONL 大小無關**（1KB 與 47MB 實測皆 ~1.5s）——由 `claude` binary 的 **spawn 主導**，不是 JSONL 載入；model 回應延遲 warm 與 resumed 相同（Claude 每輪都重送完整 context）。整個 Shelf 層 wake ≈ exec 開機 ~250ms + claude resume ~1.5s + MCP/skills reload（config-dependent，0…數秒）。裸 tab ~1.75s;**MCP-heavy tab 由 MCP respawn 主導、可能數秒**。

**Reason：** 這讓「idle 就 teardown、下次互動再 resume」對 Claude 成本低且不隨對話變長而退化——idle-teardown 這類手段對 Claude 划算。MCP-heavy tab 是唯一讓 wake 明顯變慢的變因，值得考慮排除或給較長 timeout。

**Do not change casually because：** 別假設「長 session resume 較慢」（47MB 實測已反證）；wake 慢的元兇是 MCP respawn，不是 history 載入。

## agent-providers#32 — Codex account quota/usage 走官方 `codex app-server` JSON-RPC，不走 TypeScript SDK  ·  [Decision]

**Decision：** Codex 的 account subscription quota / usage 要透過官方 `codex app-server` 的本機 JSON-RPC 讀取，而不是 `@openai/codex-sdk` TypeScript SDK。Shelf 已經為 Codex login spawn app-server，因此 quota/usage 應復用同一條 app-scoped `CODEX_HOME` auth boundary，呼叫：

- `account/read`：確認目前 account / auth 狀態（輸出可能含 email，UI/log 必須遮罩）
- `account/rateLimits/read`：ChatGPT/Codex rate-limit buckets
- `account/usage/read`：Codex token activity summary / daily buckets

**Reason：** 官方 TypeScript SDK 目前只在 turn lifecycle 裡提供 per-turn token `Usage`（例如 `turn.completed`），不提供 account-level subscription quota API。官方 Codex app-server manual 才列出 `account/rateLimits/read` 與 `account/usage/read`。這些 method 依賴 Codex service-backed auth（ChatGPT/device-code、external token、agent identity、PAT 等）；API-key-only / Bedrock 這類路徑拿不到 ChatGPT account quota。

**Observed shape（只讀 probe）：** 對 prod app scoped `CODEX_HOME=~/.shelf/apps/<appId>/codex` 呼叫 app-server 成功：

- `account/read`：`type: "chatgpt"`、`planType: "plus"`、`requiresOpenaiAuth: true`（email 已遮罩）
- `account/rateLimits/read` top-level keys：`rateLimits`、`rateLimitsByLimitId`、`rateLimitResetCredits`
- `rateLimitsByLimitId` 可有多個 bucket，例如：
  - `codex`：`planType: "prolite"`、`primary.usedPercent`、`primary.windowDurationMins`、`primary.resetsAt`、`credits`
  - provider/model-specific bucket（實測為 `codex_bengalfox`）：`limitName`、`planType`、`primary.*`
- `rateLimitResetCredits`：`availableCount` + `credits[]`
- `account/usage/read` top-level keys：`summary`、`dailyUsageBuckets`
- `summary`：`lifetimeTokens`、`peakDailyTokens`、`longestRunningTurnSec`、`currentStreakDays`、`longestStreakDays`
- `dailyUsageBuckets[]`：`startDate`、`tokens`

**Implementation note：** 這是 local app-server JSON-RPC，不是 OpenAI Platform public REST API；不要把它建模成一般 OpenAI API key call。輸出如果進 status/log/diagnostics，必須只保留 quota/usage 數字與 bucket metadata，遮罩 email / account id / token / auth payload。`rateLimitsByLimitId` 的 key 與 bucket 數量不可寫死；以 provider 回傳為準。

**Do not change casually because：** 別在 Codex SDK wrapper 裡硬找不存在的 account quota method；也別自行解析 Codex credential files。auth、refresh、credential layout 都應由官方 app-server/CLI 擁有，Shelf 只用 app-scoped `CODEX_HOME` 指定 device boundary 並打官方 JSON-RPC。

**Related：** `agent-providers#15`（per-appId `CODEX_HOME` device auth）、`agent-providers#16`（provider backend 不承攬 credential internals）、官方 Codex manual `codex-app-server.md` / `codex-sdk.md`。

## agent-providers#33 — Canonical `codex` 採 app-server-only，不保留 SDK/ACP fallback  ·  [Decision]

**Decision：** Canonical provider key 是 `codex`，直接使用 pinned `codex app-server` JSON-RPC。Production 不保留 `@openai/codex-sdk` wrapper、`@agentclientprotocol/codex-acp` adapter、hidden alias 或 runtime fallback。

**Reason：** live smoke 已驗證 app-server-only 能提供互動 provider 需要的一條 truth source：`thread/start`/`thread/resume`、`turn/start`、model catalog、skills/MCP status、slash/control、manual compact、account quota、session context usage、tool/file/command/MCP item notifications，以及 command/file/permission approval request bridge。TypeScript SDK 則是 `codex exec` wrapper；它缺少上述 control/context/status surface，若和 app-server 混用會把 session truth、compaction、context accounting、approval state 分裂成兩套 authority。

**Implementation note：** `providers/codex/` 封裝 app-server client/translator/config/auth/account status。Packaged與 remote runtime 只保留 `@openai/codex` CLI launcher、target native package與 agent-server bundle；shared ACP toolkit仍為 Copilot保留。

**Current app-server surface：** final provider behavior should stay on the app-server routes already proven/implemented: `initialize` / `model/list` for capabilities, `thread/start` / `thread/resume` / `turn/start` / `turn/interrupt` for session and turn lifecycle, `item/agentMessage/delta` and item notifications for timeline primitives, `thread/tokenUsage/updated` for session ctx, `thread/compact/start` for `/compact`, `mcpServerStatus/list` for `/mcp`, `skills/list` for `/skills`, and `account/rateLimits/read` / `account/rateLimits/updated` for quota buckets. `account/usage/read.summary.lifetimeTokens` is account-level activity, not session context pressure; do not label or position it as `ctx`.

**Open follow-ups：** MCP elicitation form 尚只 fail-loud cancel；`/ps`、`/stop`、`/clean` 等 background-task slash 仍因 app-server schema 缺穩定 route 而 explicit unsupported；create/delete file changes 若 app-server 只給 raw file content 而非 unified diff，UI 仍會 fallback markdown；reasoning item 常為空，暫保留 bounded `reasoning-notification` debug log觀察。Skill root 設計若要改，不要搬回舊 SDK 的 `$HOME/.agents/skills` 假設；先以 current app-server `skills/list` / `skills/extraRoots/set` 實測為準。

**Do not change casually because：** 不要把 TypeScript SDK 加回 production path 當 fallback；那會重建 hybrid transport 問題。若 app-server 有缺口，應在 app-server request/notification bridge 補齊或明確 unsupported，而不是讓同一 provider 在 SDK/app-server 間切換。

**Related：** `agent-providers#32`（quota/usage 走 app-server）、`agent-providers#15`（per-appId `CODEX_HOME` device auth）、`UPSTREAM_WATCH.md` Codex background-task tracker。

## agent-providers#34 — Codex app-server image input must distinguish data URLs from local paths  ·  [Gotcha]

**Symptom：** Sending a pasted screenshot/image through `codex` can fail with Codex trying to
read a path that starts with `data:image/png;base64,...`, eventually surfacing a local-image read
error such as "File name too long".

**Root cause：** Shelf's AgentView used to carry pasted images to providers as `images?: string[]`
data URLs. That made renderer-local preview format double as the provider transport contract.
Codex app-server does not accept `data:image/...` in its image URL path the way ACP providers accept
inline base64; when it sees that value it can attempt a local-image read with the whole data URI as
the path.

**Fix / note：** AgentView image input uses the same upload flow as Terminal files: bytes are
uploaded to the target cwd's `.tmp/shelf/`, then sent as shared `AgentImageAttachment` objects whose
`path` is readable by the agent-server/provider host. Renderer history/user bubbles may still keep
base64 data URLs for local preview, but `agent:send` / main→agent-server provider payloads use
`attachments`. Providers convert from the uploaded path to their native schema: Codex app-server
uses `{ type:'localImage', path }`; ACP/Claude providers read the file and build their inline base64
image blocks. Legacy `images?: string[]` remains transitional compatibility; Codex app-server now
fails loud if a data URL reaches it instead of sending it as `image.url`.

**Do not change casually because：** Do not bind provider input back to renderer preview data URLs.
That reintroduces provider-specific assumptions at the wrong layer and breaks any provider whose
native input is a target-host file path. Conversely, do not move upload/path creation into a
provider-local temp dir when the existing connector upload path already handles local/remote target
placement and cleanup.

**Related：** `agent-providers#1`（provider 差異封裝在 provider 內）、`agent-providers#33`
（`codex` app-server-only path）、`contracts/agent-routing`（uploaded attachment send
contract）。

## agent-providers#35 — Persisted provider ids remain raw; runtime opens only registry-valid providers  ·  [Decision]

**Decision:** Project persistence admits unknown provider strings so old/future keys round-trip without migration. The renderer store boundary narrows raw ids through `AGENT_PROVIDERS`: explicit opens require a valid id; implicit and connect-time opens require a valid project default. Missing or invalid defaults create no AgentView and never fall back to Claude.

Project Edit renders an unknown default as no selection and preserves the raw value when the provider field is untouched. Only an explicit provider-field change replaces or removes it. Worktree creation never inherits an unknown default and requires an explicit valid selection.

**Reason:** Persisted configuration is external historical data, while runtime dispatch must be exhaustive over the current registry. Keeping those shapes separate avoids destructive migrations and prevents stale ids from reaching deploy/backend lookup.

**Do not change casually because:** Do not cast persisted strings to `AgentProvider`, restore a fallback provider, or filter stale keys independently in UI consumers. Resolution and named provider writes belong at the production project-store boundary.
