---
type: context
title: Agent Providers
related:
  - architecture/agent-execution
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
- agent-server `parseLoginPrompt` 抽 stdout 的 `{verificationUri,userCode}`（純函式，`copilot/login.ts`），走 wire `auth_login_prompt` 回 main；main 以來源 project/tab 將預填 `?user_code=` URL 送進 app-level external-URL intent gate。這對 **remote 是必要的**：CLI 跑遠端、輪詢與 credential 寫在遠端（正確，SDK 也在那讀），但 Copy/Open 的決策與 default-app side effect 留在本機。
- **成功 = login 進程 exit 0**（不靠 parse 判成敗，只靠 parse 取 URL/code）；取消 = kill；失敗 = 非 0（`auth_login_done{ok,cancelled,error}`）。
- **spawn env 必須剝除 `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`**（`scrubLoginEnv`）—— 否則 CLI 依 `copilot help environment` 的優先序直接吃 token 短路、不走瀏覽器。
- login child 是 agent-server **直接子進程**（非 `setsid` detached）→ 不進 reaper（那是給逃離 process tree 的 detached shell），改在 `dispose()` kill。

**AuthPane**：oauth kind 顯示「Login with GitHub」按鈕（呼叫 `agent.startLogin` 直接 IPC，像 `checkAuth`）；輪詢中顯示可點的預填 URL + `userCode` + Waiting + Cancel。自動產生的 intent 與使用者點 fallback link 都進同一 gate，預設 Copy、可選 Open/Cancel；`auth_login_done{ok}` → `finishLogin` 清 pane（authRequired→null），cancel 不視為 error，fail 顯示 error。

**Do not change casually because**：① 別改成自刻 GitHub device flow（B 案）—— 要拿未公開的 Copilot client_id，破裂/維護風險高，除非官方提供穩定 SDK 登入 API。② 別在 agent-server 或 main 收到 prompt 時直接開瀏覽器；remote 沒有可用瀏覽器，且使用者必須先決定 Copy/Open/Cancel。③ 別忘了 env 剝 token，否則互動登入會被既有 token 短路。

**Related**：`contracts/agent-wire-protocol`（`auth_login_prompt`/`auth_login_done`）、`contracts/external-url-intent`、`agent-providers#2`（gh token 路徑，與互動登入正交並存）、`agent-server/providers/copilot/login.ts`、`src/main/agent/login-url-intent.ts`、`src/renderer/components/agent/AuthPane.tsx`。

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

**claude 例外（已知、非平凡的未來 migration）**：claude auth 是 `sdk-managed`，仍靠 **ambient `~/.claude`**。AuthPane 的 Log in 只在來源 project 開可見 terminal 執行公開的 `claude auth login`；它不把 Claude credential 搬進 per-app home。套 device 模型到 Claude 仍會 (a) 打破 ambient 沿用 (b) 要重做 credential ownership (c) 撞 `CLAUDE_CONFIG_DIR` 弱連結（未文件化）。只有 OAuth 路徑受影響（`ANTHROPIC_API_KEY` = 正交 token 路徑），所以 Claude 現況刻意留 ambient（odd-one-out）。

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

**Superseded by `agent-providers#45`.**

## agent-providers#18 — Provider 清單單一來源:`AGENT_PROVIDERS` registry,型別 derive,消費端一律 iterate  ·  [Decision]

**Superseded by `agent-providers#36`.**

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

**Background/Symptom**：copilot `--acp` **省略 `agent_message_chunk.messageId`**（ACP 唯一的訊息邊界訊號;spec 對「省略時」無 fallback,見官方 message-id RFD）。Shelf 必須自行產生 fallback id；同一 turn 若只用一個 id，開場與工具後的收尾會折疊到最早卡片；若 namespace 使用 process-local turn sequence，agent-server restart 後 resume 同一 session 又會重用歷史 id，讓新回覆覆寫舊卡並留在舊 timestamp，看起來像當前對話漏訊息。

**Decision**：在 `client.ts drivePromptTurn` 為每個 prompt 建立跨 process 唯一的 opaque namespace，並用 **tool 邊界切段**——文字之後出現 `tool_call`(wire `message`)就 `seg++`,下一段文字換新 id `sessionId#promptUuid:text:<seg>`(text/thinking 共用 seg)。**Mirror Zed 參考 client** 的 `push_assistant_content_block`:上一筆是 assistant message 才 append、是 ToolCall 就開新 entry。每段文字各自成卡、落在自己的時序位置；agent 有提供真 `messageId` 時原樣使用。

**Do not change casually because**：ACP 沒有「訊息完成」旗標(`ContentChunk` 只有 content/messageId/_meta;`stopReason` 是 turn 級),tool 邊界是唯一可靠的推斷。fallback namespace 不可退回 process-local counter，也不可從 content 推導；renderer 的 `msgId` 是 session history 的 upsert key，必須對所有已持久化歷史保持唯一。agent 若**有**送 messageId(codex)則 `namespaced` 直接用真 id、不套切段,別破壞那條路徑。

## agent-providers#22 — reconnect 排序用「發起時間」:`upsertMessage` 必須持久化 upsertById 保留後的 timestamp,不是原始 msg  ·  [Gotcha]

**Symptom**：live 順序正確,但 disconnect→reconnect 後,一個 turn 的所有 reply **全擠到最後**(過了交錯的工具卡),時序跑掉。

**Root cause**：卡片的正確排序時間是**發起時間**(工具 = 初次 `tool_call`;文字 = 初次串流,`flushChunkBuffer` 建卡時 `Date.now()`)。`upsertById` 在**記憶體**保留這個早 timestamp(finalize/completed 替換時 `next[i]={...built, timestamp: prev[i].timestamp}`)→ live 正確。但 `upsertMessage` 的 `markDirty` 原本存的是**原始 `msg`**(buildAgentMsg 的 finalize-time `Date.now()`,晚)→ IDB 存成「結束時間」→ reload 依 `by-session-time` 重排就用了結束時間。

**Fix / note**：`upsertMessage` 改成 `markDirty(tabId, tabs.get(tabId).messages.find(id))`——持久化**記憶體裡保留後(發起)的** timestamp。原則:**訊息/工具一律以發起時間排序**;任何「替換既有卡」的持久化都要存保留後的版本,別存新 msg 的時間。

## agent-providers#23 — copilot read/view 內容在 `rawOutput`(非 `content`);完成但無輸出的工具要標 settled,避免 reload 誤判 orphan  ·  [Gotcha]

**Symptom**：(a) Read/Viewing 工具卡片內容空白;(b) reconnect 後這些卡片被標紅 `Session ended before completion`。

**Root cause**：copilot 的 read/view 把檔案內容放 **`rawOutput`**(`{content: "..."}`),**不是** ACP 標準 `content` 陣列;translate 原本只讀 `content` → 內容被丟掉、卡片無 body。而 renderer reload 的 `reviveOrphanPending`(`storage/agent-history.ts`)把「無 body 且無 errorMessage」的 fold 卡片當成**崩潰在半途的 in-flight 工具** → 補 `Session ended before completion`。

**Fix / note**：`translate.ts` `rawOutputToText()` —— `content` 為空時 fallback 抓 `rawOutput`(handle `{content}` copilot / `{formatted_output}` codex / 純字串)。另:`status==='completed'` 但仍無文字的工具,**送空 body `{content:''}`** 標記 settled(reload 就不誤判);renderer `AgentMessage` fold_code 對**空 content 不渲染空灰條**。in-flight(pending/in_progress)仍保持無 body → 真崩潰照樣被 reload 標出。

## agent-providers#24 — Copilot `task_complete` 有內容時視為一般對話結尾  ·  [Decision]

**Decision**：pure ACP translator 把 `title === 'task_complete'` 且帶內容的摘要直接翻成 Markdown `reply`（靠 session-scoped tool metadata carry 保留 title），一律使用一般 assistant 對話 surface；裸訊號（無內容）仍不顯示。

**Reason**：Copilot 把最終摘要放在 internal `task_complete` tool 的 `content`／`rawOutput`，而且是否另送 `agent_message_chunk` 不穩定。依前面是否已有 assistant chunk 分類，會讓同樣是最終回答的內容有時呈現成一般對話、有時落進 `Task completed` note。結尾語意應一致；即使前面已有進度文字，最終摘要仍是正常 assistant reply。

**Do not change casually because**：這是 **Copilot title 慣例的特判，不是 ACP 標準**；Copilot 改名就會失效。terminal update 可能在 prompt settlement、甚至下一 prompt 開始後才到（`#37`），所以 output sink 必須維持 session lifetime；不要用 stop reason 當內容 barrier。`task_complete` 無內容時仍只是一個控制訊號，不應產生空 reply。

## agent-providers#25 — copilot ACP 不 emit `usage_update` → status bar 對 copilot 沒有 ctx / cost / AI-credit（等上游 #4233）  ·  [Gotcha]

**Symptom**：copilot 的 agent status bar 只有 `state | provider | model | mode | effort`,缺 `ctx: NN%` 及其後的 cost / turns / credit（claude 有）。

**Root cause**：`ctx`(context usage)來自 ACP `usage_update`（`translate.ts` 已有 handler,讀 `used`/`size`）。但 **`copilot --acp` 從不 emit `usage_update`**——它認得這個 type（在自己的 ACP schema 裡）卻不送。資料其實存在於 copilot CLI 內部（`/context`、`/usage`、experimental `statusLine.command` 的 `context_window.*`、`aiCreditsUsed/Remaining` 都算好了),只是沒透過 ACP 轉發（parity gap）。`numTurns`/`rateLimits` 則是 **Claude SDK 專屬**、ACP 標準沒有,copilot 本就給不出。

**Fix / note**：**不自己估**——Zed 對 copilot 硬編 128k context window、估錯（[zed#44909](https://github.com/zed-industries/zed/issues/44909)）。已開上游票 [copilot-cli #4233](https://github.com/github/copilot-cli/issues/4233) 要 ACP emit `usage_update`（ctx 走標準 `used`/`size`/`cost`；AI-credit 走 `usage_update._meta`）。**ctx 仍等上游**（修好後自動亮,handler 現成）。**AI-credit 已不等 ACP**：改走 SDK `account.getQuota` 取 account-level premium 額度（見 `#26`）——這是 account 級、跟 session ctx 無關,不需要 #4233。`numTurns`/`rateLimits` 是 Claude SDK 專屬,copilot 給不出。

**Related**：`agent-server/providers/acp/translate.ts`（`usage_update` handler）、`agent-providers#26`（credit via SDK）、`src/renderer/components/agent/StatusBar.tsx`、`UPSTREAM_WATCH.md`。

## agent-providers#26 — copilot account credit 走 SDK `account.getQuota`（config-home auth）+ 每 host cache-aside(15min)+ execution-end 觸發,executionId-less status 送渲染  ·  [Decision]

**Decision**：copilot 的 **account-level AI-credit**（premium requests 用量）不走 ACP,改用 `@github/copilot-sdk` 的 `account.getQuota`。封裝在 `agent-server/providers/copilot/credit.ts`:
- **Fetch**：`new CopilotClient({ connection: RuntimeConnection.forStdio({ path: <shipped copilot bin> }), env: copilotEnv(appId), useLoggedInUser: true })` → `start()` → `rpc.account.getQuota({})` → `stop()`。`normalizeCredit` 取 `quotaSnapshots.premium_interactions` → `StatusSegment`（`premium: used/total (pct%)`,severity 隨剩餘 %;`isUnlimitedEntitlement`/缺欄位 → `null` 不顯示）。
- **Auth = config-home,不碰 token 檔**：`useLoggedInUser:true` + `env.COPILOT_HOME = ~/.shelf/apps/<appId>/copilot`（ACP session 用的同一個 per-app config-home）→ SDK 用 CLI 既有登入態認證,不讀 copilot 私有 token 檔。守住 device-scoped-auth / provider-boundary（`#15`/`#16`）。
- **Cache-aside**：`refreshCopilotCredit` 打 dispatcher 的 per-host cache（`agent-dispatch.md` 的 `ModelCacheClient`）,**TTL 15min**。key = 單一 `account-credit`（**不帶 appId**:一個 host = 一個 config-home = 一個 user)。沒有 dispatcher cache 時退化用 process-local fallback（仍受 TTL 節流）。任何 error → fail-quiet 不顯示。
- **觸發 = execution-end**（無開場 fetch,對齊 claude 首輪後才有 status）。`exec.ts` 在 `backend.query` 後 fire-and-forget `backend.refreshAccountStatus?.(cache, send, appId)`（`ServerBackend` 選配 hook）,用 **base send（executionId-less）**。
- **送渲染**：credit status **不帶 `state`**（status wire `state?` 因此設為選配,避免 credit-only status 誤翻 streaming）。`execution-dispatcher` 特判「executionId-less 的 `status`」→ 走 `onSessionEvent`（session-scoped）→ IPC → store `setStatus` 合併 `credits` → `StatusBar.tsx` 渲染,不進 execution reader。

**Reason**：credit 是 account 級、ACP 無標準欄位且 `copilot --acp` 不 emit usage（`#25`）,SDK 是今天唯一乾淨路徑。spawn copilot binary 有成本 → 每 host 15min 一次、execution-end 才查、cache 共用,把 spawn 頻率壓到最低。

**Do not change casually because**：(1) 拿掉「executionId-less status → onSessionEvent」特判,credit status 會因無對應 execution 被丟棄。(2) 把 `state?` 改回必填,credit-only status 會誤觸發 streaming 旁效。(3) cache key 加回 appId 會讓同 host 多 tab 各自 spawn,失去共用。(4) `account.getQuota` 是 `@experimental` → 一定 fail-quiet,別讓它 block execution 或 crash。

**Related**：`agent-server/providers/copilot/credit.ts`、`agent-server/providers/copilot/helpers.ts`（`resolveCopilotBinary`/`copilotEnv`）、`agent-server/exec.ts`、`agent-server/providers/types.ts`（`refreshAccountStatus` hook + `credits`）、`src/main/agent/execution-dispatcher.ts`、`src/renderer/components/agent/StatusBar.tsx`、`architecture/agent-dispatch.md`（per-host cache）。

## agent-providers#27 — streaming caret 維持「單一 active」不變式:flush 時 settle 非當前段,別等 turn-end idle  ·  [Gotcha]

**Symptom**：copilot 一個 turn 內出現多個閃爍光標——每則助理 reply 卡都掛著 caret,而不是只有正在輸出的那則。

**Root cause**：caret 就是 `message.streaming === true` 時渲染的 `.agent-cursor`（`AgentMessage.tsx`）。`streaming` flag 由 `appendChunk`/flush 設 true,但**原本只有 `setExecutionActive(false)`（turn-end idle）一條路清它,且一次清光**。boundary-split（`#21`）把一個 turn 的文字切成多則各自 msgId 的 chunk-only reply(無 per-segment finalize),中途沒有任何地方 settle 前一段 → 全部撐到 idle 才清 → 多 caret 併存。claude 因單一 msgId 全程同一則、不觸發。

**Fix / note**：在 `flushChunkBuffer`（`agentTabStore.ts`）維持**單一 active caret 不變式**:記住這次 flush 最後寫入的 msgId（buffer 為插入序,末筆＝最新＝ live），迴圈後把其餘仍 `streaming:true` 的 reply/fold_text 就地 `streaming:false` + `markDirty`（在段落邊界就落 IDB,對齊 `setExecutionActive(false)` 的清理與持久化語意;`appendChunk` 本身刻意不 markDirty,partial 不落盤,所以這裡是唯一寫入點)。**別改回「只在 idle 清」**——會讓 boundary-split 的每段殘留 caret。前提:ACP 邊界只往前走,不回填前一個 msgId(若某 provider 會回填,單一 active 假設要重審)。

**Related**：`src/renderer/agentTabStore.ts`（`flushChunkBuffer` / `setExecutionActive`）、`src/renderer/components/AgentMessage.tsx`（`.agent-cursor`）、`agent-providers#21`（boundary-split 是成因）。

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

**Do not change casually because:** Do not cast persisted strings to `AgentProvider`, restore a fallback provider, or filter stale keys independently in UI consumers. Raw compatibility belongs to the main project loader/formatter; runtime resolution and named writes belong at the canonical project/store boundary.

## agent-providers#36 — Provider key 是不可變 identity；registry 集中 presentation、visibility 與 runtime binding  ·  [Decision]

**Decision：** `AGENT_PROVIDERS` 是 provider identity 的單一來源。registry key 是跨 renderer state、routing、persistence、backend cache 與部署路徑流動的 opaque immutable id；`AgentProvider` 與可自訂 model 的 provider subset 都由 registry metadata derive，不另寫 union。`label` 只供顯示，`visibility`（`product` / `internal`）只決定 presentation policy，`bin` 則是 provider-specific remote runtime binding，允許 `null` 表示只需 base runtime。registry membership 代表 provider 是完整、可呼叫的 provider；backend factory 必須 exhaustive，provider 目錄 basename 也必須與 key 對齊（共用 toolkit 目錄除外）。

Renderer 在 dev/E2E 傳入是否顯示 internal provider 的環境政策，再由 registry helper 產生選項；label 不得回流成 routing key。Auth event 的 display content 由 provider 擁有並原樣顯示，也不得拿來推導 provider identity。`fake` 因此是普通的 registered internal provider：顯式選取時 identity 就是 `fake`；`SHELF_TEST_MODE` 只把 requested provider 的 backend implementation 換成 fake，requested key、per-provider cache 與其他 identity flow 不變。

**Reason：** identity 與 presentation 分離後，rename label 不會破壞已持久化設定或 runtime dispatch；新增 provider 只需在 registry 與 exhaustive factory 各完成一處。把 fake 正式建模為 internal provider，能沿用完整 production 路線而不引入 test-only validity 分支；保留 requested key 的 test substitution 則能驗證真實 provider state isolation。

**Do not change casually because：** 不要散落 provider key/label magic string（宣告本身、provider 目錄名與故意的 invalid fixture 除外）；不要用 label、auth 文案或 visibility 做 dispatch；不要為 fake 建特殊合法性路徑，也不要讓 test mode 把不同 requested provider 合併成同一 cache key。現有 persistence/auth/config location 不做 alias migration；若新增 provider，必須維持 key-isolated state、cache 與 runtime 路徑。

**Related：** `agent-providers#1`、`agent-providers#35`、`agent-core#5`、`deployment#8`、`src/shared/agent-providers.ts`、`agent-server/backend-registry.ts`。

## agent-providers#37 — ACP update router 必須是 session-scoped，不能綁 prompt settlement  ·  [Gotcha]

**Symptom：** Copilot 的最後一段（通常是 `task_complete` 最終總結）可能在 prompt response／stop reason 已 settlement 後才由 SDK callback 送達。若 update sink 跟 prompt 一起關閉，內容會延遲到下一次 send 或直接遺失。

**Root cause：** ACP SDK 的 prompt response 與 session notification callback 是獨立排程；response 先 resolve 不代表所有 renderable update 都已 callback。bundled Copilot ACP 更進一步以 `wait:false` 呼叫內部 `session.send()`，所以 `session/prompt` response 只代表工作已排入，不代表 Autopilot 已停止執行。這不是 Shelf 能以固定 delay 或一般 content drain 猜出的 protocol boundary。

**Fix / note：** ACP driver 的 update router 與 render sink 跟 session 同壽命；所有 ACP renderable updates 一律繼續走同一條 session content sink，所以 late final message 會按到達時序正常顯示。Copilot **Autopilot 的一般任務**額外以 provider-native `task_complete` terminal tool update 作 execution boundary：每個 prompt 都必須在 `session/prompt` 開始前先安裝 completion observer，因為 restored session 可能等到 prompt 已開始才送 authoritative `current_mode_update:'autopilot'`；prompt settlement 時再依當下 mode 決定是否等待。observer 先記住帶 title 的 tool id，後續同 id 的 `status:'completed'` 才 emit idle、完成 reader 並釋放下一則 queued send；`session/prompt` 提前回覆時仍維持 running。ACP 已透過 `available_commands_update` advertise 的 slash command（例如 `/compact`）由 command handler 自己完成，且不會呼叫 Autopilot `task_complete`，因此以該 command 的 prompt settlement 收尾；只看 `/` 前綴但未 advertise 的文字仍視為一般任務。其他 mode 沒有可靠 terminal signal，也以 prompt settlement 收尾並立即清除 observer/watchdog；因此 Copilot tab 即使 visually idle 仍保留 double-ESC stop affordance。

使用者要求取消是獨立的 control-plane boundary：若 Copilot 的 `session/prompt` 仍 active，provider 發出 `session/cancel` 後，`stop()` 必須等待同一個 prompt 回傳 `stopReason:'cancelled'` 才算成功；prompt failure、其他 stop reason 或 bounded RPC timeout 都是取消失敗，必須 fail loud。若 prompt response **已先 settlement**，就不存在可等的 cancellation acknowledgement，但 Copilot autopilot 仍可能實質工作；此時先 best-effort `session/cancel`，再關閉 ACP connection 並 kill CLI process，下一輪從 persisted session resume。這是保證 stop 的 force fallback，不改 UI idle 語意。

Tool call 的 display metadata 也是 session-scoped carry，以 `toolCallId` 暫存，terminal translate 後立即 evict；reset/forget 清空。driver 不保存 `textByMsg`，文字 delta 的累積與持久化只由 renderer 負責。`activeExecutionSend` 僅供當下 tool permission round-trip，不是一般 notification/content sink。

**Do not change casually because：** 不要在 prompt 開始前用 cached mode 決定是否安裝 completion observer；mode update 與第一個 `task_complete` update 都可能在 prompt 內到達，事後補 observer 已經漏訊號。不要恢復 per-prompt update queue、`setImmediate`/短 quiet-period barrier、current/last prompt attribution 或把一般 stopReason 當 content gate。Autopilot completion 必須追蹤 `task_complete` 的 tool id，因 terminal partial update 可能省略 title；slash 例外必須比對 agent advertise 的 command name，不能把任意 slash-like 使用者文字都當 command。所有非等待路徑以及 stop/reconnect/dispose 都必須解除 completion gate，否則 watchdog、execution reader 與 send queue 會永久卡住。30 分鐘 watchdog 只處理上游漏訊號的故障：逾時明確 emit error 後 idle，不是正常完成判斷。active prompt 時不可把 `session/cancel` 已寫入 pipe 當成取消成功；post-prompt 因已無 ack boundary，必須 force-close，不能只送 notification 後假裝已停。

**Related：** `agent-server/providers/acp/client.ts`、`agent-server/providers/copilot/index.ts`、`src/renderer/components/agent/InputZone.tsx`、`e2e/agent-flows.spec.ts`、`agent-providers#24`（Copilot `task_complete` 最終總結）。

## agent-providers#38 — Codex persisted thread 找不到 rollout 時清 pointer 並明確開新 thread  ·  [Gotcha]

**Symptom：** Codex 每次發送都回 `thread/resume failed`、JSON-RPC `-32600`、`no rollout found for thread id ...`；重送只會重複同一錯誤。

**Root cause：** Shelf 的 `lastSdkSessionId` context pointer 可存活 30 天，但 app-scoped Codex home 裡的 rollout 可能因手動清理、config-home 搬移或 upstream retention 提前不存在。Codex provider 原本每一 turn 都無條件拿 persisted id 呼叫 `thread/resume`；明確 missing-rollout 後既不清 pointer、也不 `thread/start`，因此 stale id 永久卡住該 Shelf session。

**Fix / note：** 只有 app-server 明確回報 `thread/resume` + code `-32600` + 該 thread id 的 `no rollout found` 時才恢復：先 emit `lastSdkSessionId:null`（即使後續 start 失敗也不再重試 stale id），再 `thread/start`，成功後顯示一次 system notice 並保存新 id，原 prompt 照常進 `turn/start`。其他 resume 錯誤（auth、transport、timeout、response mismatch）一律維持 fail-loud，不得用 broad catch 靜默開新 thread；否則會把可修復的連線問題偽裝成對話 context 遺失。

**Related：** `agent-providers#33`、`agent-server/providers/codex/index.ts`、`agent-server/context-store.ts`。

## agent-providers#39 — Codex capability probe 必須先用 `account/read` 擋住未登入 turn  ·  [Gotcha]

**Symptom：** 新的 app-scoped `CODEX_HOME` 尚未登入時，Codex tab 仍顯示可輸入；送出訊息後才在 Responses WebSocket 收到 `401 Unauthorized`，且 turn 因沒有 terminal event 持續顯示 running。

**Root cause：** `model/list` 未登入也可能成功，不能作為 auth probe。app-server-only cutover 若只取 model capabilities，就會漏掉原本 provider 的登入 gate。舊 app-server process 也可能保留登入前的 auth state；device-code login 由另一個 process 寫入 credential 後，post-login re-init 若不重生 runtime，仍可能回報未登入。

**Fix / note：** `gatherCapabilities` 在 `model/list` 前呼叫官方 `account/read { refreshToken:false }`。只有 `account === null && requiresOpenaiAuth === true` 才回 `authRequired:true` + ChatGPT device-code OAuth method；`requiresOpenaiAuth:false` 代表 active provider 不需要 OpenAI credential，不可誤擋。缺欄位或非預期 shape 一律讓 init fail-loud，不猜成已登入或登出。登入完成的 `reconnect` 要關閉舊 app-server，讓下一次 capabilities probe 從同一個 per-appId `CODEX_HOME` 重讀新 credential。

**Do not change casually because：** 不要用 `account === null` 或 `requiresOpenaiAuth` 任一欄位單獨判斷；API key、ChatGPT、Bedrock 等模式的 account shape 不同。不要把 auth probe 失敗降級成 bundled model fallback，否則 UI 會再次在未知 auth 狀態下放行 turn。

**Related：** `agent-providers#15`（per-appId device auth）、`agent-providers#32`（官方 account JSON-RPC）、`agent-ui#7`（AuthPane / post-login re-init ownership）、`agent-server/providers/codex/index.ts`。

## agent-providers#40 — Codex web search 使用無 body 的 fold card  ·  [Decision]

**Decision：** Codex app-server 的 `webSearch` / `web_search` item 由 provider 轉成 `fold_markdown` 渲染原語：`label` 固定為 `Web search`，頂層 `item.query` 放在 `subtitle`，不帶 body；query 缺失或為空時略過。Payload 的 `results` 不轉送 renderer。

**Reason：** Web search 與其他工具活動使用一致的 card 呈現，同時維持 renderer 只接收渲染原語、不理解 provider-native search result shape 的邊界。搜尋結果 UI 不屬於目前需求。

**Do not change casually because：** 不要為了顯示 `results` 在 renderer 加 Codex-specific 分支，或在沒有明確產品需求時擴張 search-result normalization；若要呈現結果，應另行定義跨層 UX 與資料契約。

**Related：** `agent-providers#1`、`agent-ui#5`、`agent-server/providers/codex/app-server-translate.ts`。

## agent-providers#41 — Copilot ACP 以 title 修正過度壓縮的 tool kind label  ·  [Gotcha]

**Symptom：** Copilot 尋找檔案時，卡片 subtitle 是 `Finding files matching …`，label 卻顯示 `Read`；搜尋內容時 subtitle 是 `Searching for …`，label 卻顯示泛化的 `Tool`。

**Root cause：** Copilot ACP adapter 不傳原始 tool name，且把部分工具壓成過度寬泛的 kind：`glob` 成為 `read`，部分內容搜尋成為 `other`。較精確的意圖只留在生成的英文 title（`Finding…`／`Searching…`）；共用 ACP translator 若只做 `kind → label`，就會顯示錯誤或泛化名稱。

**Fix / note：** label resolver 採兩層 fallback：先辨認窄且已知的組合（`read + Finding… → Find`、`other + Searching… → Search`），未命中再走標準 ACP kind map，最後未知值回退 `Tool`。這只改卡片 label；subtitle、body 與 `fold_code`／`fold_diff` 選擇不變。

**Do not change casually because：** 不要把所有 `read`／`other` 改成 `Find`／`Search`，也不要通用擷取 title 第一個單字；ACP title 是 provider 文案而非穩定 tool-name 欄位。若 Copilot 未來傳出原始 tool name 或修正 kind，應優先使用正式 metadata，再移除對應的窄相容規則。

**Related：** `agent-providers#6`（共用 ACP translation）、`agent-ui#5`（fold card 渲染原語）、`agent-server/providers/acp/translate.ts`。

## agent-providers#42 — Codex stop 必須關閉 app-server，不能只解鎖本地 turn  ·  [Gotcha]

**Symptom：** Codex 畫面已顯示 idle 時，背景 agent 仍可能繼續輸出或執行；double-ESC 無法停止。active turn 的 `turn/interrupt` 若失敗，UI 仍會回 idle，形成已停止的假象。

**Root cause：** Renderer 原本只在 execution busy 時允許 Codex stop；backend 又會吞掉 `turn/interrupt` 錯誤並直接 resolve 本地 completion。UI state 與 provider process 因此脫鉤，沒有任何 control-plane 證據證明背景工作已終止。

**Fix / note：** Codex tab 即使 visually idle 仍保留 double-ESC。若有 active turn，先給 `turn/interrupt` 一個 bounded acknowledgement window；無論 interrupt 成功、失敗或逾時，stop 都關閉 app-server 子程序、取消未決 permission request、清除 in-memory thread/runtime reference，再解鎖本地 turn。下一次 send 建立新 app-server，並用 persisted `lastSdkSessionId` resume 原 thread。若 force-close 本身失敗則 stop fail-loud，不得回報成功。

**Do not change casually because：** 不要把 `turn/interrupt` 已送出或本地 promise 已 resolve 當成實際停止；也不要在 force-close 時清掉 persisted thread pointer，否則取消會不必要地丟失對話 continuity。visual idle 只代表 Shelf 沒有 active execution，不代表 provider process 無背景工作。

**Related：** `agent-server/providers/codex/index.ts`、`src/renderer/components/agent/InputZone.tsx`、`e2e/agent-flows.spec.ts`、`agent-providers#37`。

## agent-providers#43 — Double-ESC stop 必須是連續且獨立的按鍵手勢  ·  [Gotcha]

**Symptom：** 使用者在 Agent input 打字時，Copilot 突然顯示 `Operation cancelled by user`。main log 證實 Shelf 確實送出 stop，但使用者沒有刻意連按兩次 ESC。

**Root cause：** 第一次 ESC 會把 stop confirmation armed 1.5 秒；原本只有逾時或 tab 不再 eligible 才清除。這段期間的文字輸入、paste、IME composition 都不會解除 armed，長按 ESC 產生的 repeated keydown 也會被當成第二次按鍵，因此正常輸入流程可能意外完成 stop 手勢。

**Fix / note：** Double-ESC 只接受兩次連續、非 repeat、非 IME composition 的 Escape keydown。第一次 ESC 後只要發生文字變更、其他按鍵或 composition key event，就清除 pending confirmation；第二次 ESC 只會重新 arm，不會停止。Copilot/Codex visually idle stop eligibility 不變。

**Do not change casually because：** 不要只依賴 1.5 秒 timer 或 `nativeEvent.isComposing`；timer 不是手勢連續性的證明，IME event ordering 也不能取代「任何輸入都中止 stop 手勢」的規則。也不要讓 `KeyboardEvent.repeat` 完成 double press。

**Related：** `src/renderer/components/agent/InputZone.tsx`、`e2e/agent-flows.spec.ts`、`agent-providers#37`、`agent-providers#42`。

## agent-providers#44 — Copilot ACP autopilot 不等於 allow-all；Shelf bypass 必須自行 auto-approve  ·  [Gotcha]

**Superseded by `agent-providers#45`.**

## agent-providers#45 — Permission control 由 provider 選 strategy；Copilot 原樣採 ACP state  ·  [Decision]

**Decision：** `ProviderCapabilities.permissionControl` 明示 `shelf` 或 `native` strategy。`shelf` 保留既有 canonical `permissionModes`、project pref 與 provider adapter；`native` 則提供一個 mode control 與一個 permission control 的 descriptor，renderer 只依 descriptor 畫 UI，不依 provider identity 分支。這是刻意窄化的 permission surface，不是把任意 ACP config 動態生 UI。

Copilot 選 `native`：ACP session modes 原值送 `session/set_mode`；ACP `allow_all` config option 原值送 `session/set_config_option`。兩者是獨立狀態，`autopilot` 不再映成 Shelf `bypassPermissions`，permission callback 也不自行 auto-approve。`/allow-all`、`/yolo`、`/reset-allowed-tools` 仍是 Copilot CLI 的原生 slash 語意，Shelf 不攔截或改寫。

**Truth / lifecycle：** UI 顯示以 `session/update` 與 config response 的完整 options 為準；bare acknowledgement 不做 optimistic mutation。Copilot 的 mode id 是 ACP well-known URI（例如 `https://agentclientprotocol.com/protocol/session-modes#autopilot`），而且同一份 mode state 同時出現在 `SessionModeState` 與 `category=mode` config option；`set_mode` 後目前會用完整 `config_option_update` 回報，因此 backend 必須把該 snapshot 的 `currentValue` reconcile 回 session mode，再發布 capabilities。只等 `current_mode_update` 或用 `autopilot` 短字串比較，都會讓 status bar／Autopilot completion gate 留在錯誤狀態。沒有 advertise 的 control 就省略，advertise 後 shape/value 不合法則 fail loud。native control 不讀寫 `AgentPrefs.permissionMode`，也不 migration/delete 舊值；confirmed mode/permission 分別使用 `nativeMode` / `nativePermission` 持久化並在 warm-up 重套。恢復既有 Copilot session 時，必須先用 agent advertise 的 restore method 取得 mode/config state，再產生 capabilities；不可為了 discovery 先建立 fresh ACP session。

**Reason：** 保留 Shelf 統一詞彙雖有一致 UX，但需要維護 mode mapping、雙向同步、slash side effect 與 provider-specific error recovery。原生 CLI 使用者已熟悉其語意，也能直接查到上游文件；讓 SDK/CLI 保持 authority 可縮小失同步與漏接更新的風險。strategy seam 讓本次只改 Copilot，Claude/Codex 不受影響。

**Do not change casually because：** 不要用 provider-name branch 選 UI，也不要把 native control 持久化成 canonical permission pref。Native 專用 preference 欄位不改變 provider snapshot 的 runtime authority。不要把所有 ACP config option 泛化成 settings panel；若別的 provider 要 native strategy，必須明確描述同一個窄 surface。不要把 mode 當 allow-all，或重新加入 permission handler short-circuit。

**Related：** `agent-config-flow#9`、`contracts/agent-routing`、`contracts/agent-wire-protocol`、`src/shared/permission-controls.ts`、`agent-server/providers/copilot/index.ts`、`agent-server/providers/acp/client.ts`。

## agent-providers#46 — Copilot reconnect 依 ACP capability 選 restore；load replay 不進 Shelf timeline  ·  [Decision]

**Decision：** Copilot capabilities probe 在建立任何 native session 前先載入 provider-matched `lastSdkSessionId`。Agent advertise stable `sessionCapabilities.resume` 時走 `session/resume`；只有 legacy `loadSession` 時走 `session/load`。`session/load` 的 conversation replay 在 ACP driver hydration 階段不轉成 renderer content，但 mode、config options 與 available commands 仍更新 session state。Hydration 期間的 `current_mode_update` / `config_option_update` 是較新的 authoritative snapshot；ACP driver 必須把它們 reconcile 進 load result，不能讓 request response 的舊值在 await 返回後蓋回去。兩者都沒 advertise 就 fail loud。

Fresh capabilities probe 若建立 `session/new`，立刻透過 session-scoped `context_patch` 寫回 native ID；不能等第一個 prompt，因為 prompt 會 reuse live session 而不再發 patch。Restore failure 預設維持原錯誤並阻止 `session/new`；唯一例外是 `agent-providers#47` 的明確 missing-session recovery。

**Reason：** capabilities 在 prompt 前執行，若它先建立未持久化的新 session，renderer 歷史與 provider context 會分叉。Bundled Copilot 的 ACP surface 可能只提供會 replay history 的 `session/load`；Shelf 已有自己的持久 timeline，重播進 UI 會重複訊息，但完全忽略或晚套用 load notifications 會漏掉 config/command metadata，並可能把實際 Autopilot 誤判成 agent mode，跳過 `task_complete` completion gate 而提早 idle。分開「hydrate metadata」與「render replay」可保留單一 timeline ownership並繼續原對話。

**Do not change casually because：** 不要把 `loadSession: true` 當成可呼叫 `session/resume`，也不要無條件偏好 load；以 initialize capabilities 選 method。不要 broad-catch restore 後靜默開新 session，也不要把 `lastSdkSessionId` 暴露到 renderer/main wire。Replay suppression 只限 restore hydration window；正常 prompt update 仍必須完整送達。

**Related：** `agent-providers#37`、`agent-providers#45`、`architecture/agent-execution`、`contracts/agent-routing`、`contracts/persistence-formats`、`agent-server/providers/acp/{connection,client}.ts`、`agent-server/providers/copilot/index.ts`。

## agent-providers#47 — Copilot persisted session 明確不存在時清 pointer 並開新 session  ·  [Gotcha]

**Symptom：** Copilot tab 初始化失敗並顯示 `Resource not found: Session <id> not found`；Retry 只會用同一個 persisted `lastSdkSessionId` 再次 restore，因此無法自行恢復。

**Root cause：** Shelf 的 context pointer 可能比 Copilot CLI 的 session storage 活得久。Capabilities probe 會在顯示輸入框前 restore provider session；原本任何 restore failure 都 fail-loud，連 ACP 明確回報 session 不存在也不例外，所以 stale pointer 會永久卡住該 Shelf session。

**Fix / note：** 只有 ACP `RequestError.code` 等於官方 SDK `RequestError.resourceNotFound().code`（目前為 `-32002`），且 message 明確包含同一個 session ID 的 `Resource not found: Session <id> not found` 時才恢復：先 emit `lastSdkSessionId:null`，再走 `session/new`；成功後保存新 ID，並顯示一次 system notice 說明舊 conversation context 無法恢復。Final session 建立後仍須依 `agent-providers#51` 重套 project selections；replacement session 的 provider defaults 不是 durable preference。其他 restore failure（auth、transport、protocol、timeout 或不同 ID）維持 fail-loud，不得 broad-catch 後靜默開新 session。Regression mock 也必須由同一個 SDK helper 取得 code，不可另外手寫數字，否則會讓測試通過但正式 transport 無法觸發 fallback。

**Related：** `agent-providers#38`（Codex 同類窄 recovery）、`agent-providers#46`、`agent-server/providers/copilot/index.ts`、`agent-server/context-store.ts`。

## agent-providers#48 — Copilot ACP 新 prompt 會 abort 上一輪並偽裝成使用者取消  ·  [Gotcha]

**Symptom：** 使用者沒有按 ESC，送出下一則訊息時，正常回答前仍出現 `Info: Operation cancelled by user`，而且兩段文字合併在同一個 assistant reply。

**Root cause：** bundled Copilot CLI 的 ACP `session/prompt` handler 在每個新 prompt 開始前無條件呼叫 `session.abort()`。若上一輪 ACP request 已回覆、但內部尾端工作仍在 settle，新 prompt 會 abort 該工作。Copilot 隨後 emit `session.info { infoType: "cancellation" }`；ACP adapter 丟失 `infoType`，將內容壓成無 message id 的 `agent_message_chunk`。共用 ACP translator 因此只能把它視為一般 assistant delta，並與同一 prompt 的正常回答累積在同一個 bubble。

**Fix / note：** 只在 Copilot provider 的 session-update 邊界辨認並略過精確的 adapter 產物 `Info: Operation cancelled by user`；共用 ACP driver 保持 provider-neutral。Autopilot execution 另等到 `task_complete` completed 才釋放下一則 queued prompt，避免因 ACP request 提前回覆而主動撞上這個 abort；窄文字 filter 仍保護其他 mode 與上游 race。Shelf 的顯式 stop 已由自己的 control/status path 回饋，不依賴這段 provider 文字。其他 `Info:`、warning、error 與正常 assistant chunk 不受影響。

**Do not change casually because：** 不要在共用 ACP translator 全域過濾這個字串，也不要把所有 `Info:` 都吞掉。上游若保留 `session.info.infoType`、改成非 assistant update，或不再在新 prompt 前 abort，應移除此窄 workaround 與對應 regression test。

**Related：** `agent-providers#37`、`agent-providers#43`、`agent-server/providers/copilot/index.ts`、`agent-server/providers/copilot/helpers.ts`、`agent-server/providers/copilot/copilot.test.ts`。

## agent-providers#49 — Claude OAuth 有效性以 CLI status 為準；warmup / Check again 共用三態 latch  ·  [Gotcha]

**Symptom：** OAuth token 過期的 Claude tab 在 warmup 仍顯示 history，直到送出第一則訊息才回 `401 OAuth access token has expired` 並顯示 AuthPane；未重新登入直接重試時，pane 又被錯誤清掉，下一個 turn 重複 401。

**Root cause：** SDK `accountInfo()` 的 `tokenSource` 只證明 credential 存在；過期 OAuth token 仍回 `oauth`，所以不能作有效性判斷。models/commands cache 又兼任成功 memo，live SDK query 也已讀入舊 token，單純再 probe 會同時沿用錯誤 verdict 與 stale query。bundled Claude Code 的登入 subcommand 是 `claude auth login`，不是一般 CLI 入口的 `claude login`。

**Fix / note：** warmup 與 Check again 都先用 provider 同一支 Claude binary / ambient env 執行公開的 `claude auth status --json`。first-party `loggedIn:false` 在建立 SDK query 前直接回 `authRequired`；非 first-party（Bedrock / Vertex / gateway）是外部 auth，不套 OAuth gate。probe 是 `authenticated / unauthenticated / unknown` 三態：fresh warmup 的 unknown 可退回 `accountInfo()` 相容路徑，避免 transient process error 誤鎖；一旦 CLI 或 structured mid-turn frame 確認 auth failure，就 latch，unknown 不得解除，只有 definite authenticated 才能清。Claude `reconnect()` 同步收尾 active turn、關閉/abort stale query、清 models/commands memo，但保留 `lastSessionId` 讓登入後 resume 原 history。AuthPane 的 Check again 只負責這條驗證；登入啟動與 PTY 互動由 `agent-providers#50` 的可見 terminal flow 負責。

**Do not change casually because：** 不要把 `accountInfo().tokenSource !== 'none'` 恢復成第一方 OAuth 的主要有效性判斷，也不要讓 unknown 清除已知 401；兩者都會重現「回 history、下一則再 401」。`checkAuth` 的 `reconnect → get_capabilities` 依 main→agent-server FIFO 順序成立，reconnect 必須同步 drop refs，但不得清 provider context pointer。不要用 SDK 未公開的 Claude OAuth control methods 取代 external CLI flow；目前的 UI/protocol 沒有承諾該私有 surface。

**Related：** `agent-server/providers/claude/auth-status.ts`、`agent-server/providers/claude/index.ts`、`src/main/agent/remote.ts`、`src/renderer/components/agent/AuthPane.tsx`、`e2e/connector/agent-deploy-auth.spec.ts`。

## agent-providers#50 — Claude sdk-managed 登入在來源專案開可見 terminal  ·  [Decision]

**Decision：** Claude AuthPane 的 Log in 不直接呼叫 SDK 私有 OAuth API；它使用 `authMethod.loginCommand` 發出 renderer-local typed intent，由 App 在來源 agent tab 所屬專案新增並聚焦 terminal tab，再交給既有 `tabCmd` / PTY spawn 執行。terminal 因此沿用同一個 cwd、connection 與 project env，登入憑證留在 Claude runtime 讀取的 host。完成 CLI flow 後，使用者回 agent tab 按 Check again 驗證。

**Reason：** `claude auth login` 是公開且可互動的登入 surface；可見 PTY 同時支援 local、SSH、WSL、container 與 headless paste-code flow。Claude Agent SDK 的 OAuth callback control methods 未公開，而且 upstream 在 refresh-token expiry 後仍有 callback 失敗案例；把 CLI spawn 成背景 child 則會隱藏 remote/headless 必需的互動。

**Do not change casually because：** `instructions[].command` 只供顯示，不能當作任意 command execution authority；只有明確的 `sdk-managed.loginCommand` 且使用者點擊 Log in 後才可啟動。handler 必須用來源 `tabId` 找 project，不可退回 current active project，否則 tab switch/race 會把登入跑在錯誤 host。terminal 建立失敗要在 AuthPane fail-visible 並記錄來源 tab id，不得 silent return。

**Related：** `agent-providers#49`、`contracts/agent-wire-protocol`、`src/shared/types.ts`、`src/renderer/components/agent/AuthPane.tsx`、`src/renderer/App.tsx`、`src/renderer/store-projects.ts`。

## agent-providers#51 — Copilot warm-up 在 final ACP session 重套並確認 saved selections  ·  [Decision]

**Decision：** Copilot capabilities warm-up 將 project prefs 視為 initialization intent。它先 resume/load persisted ACP session；只有 `agent-providers#47` 的 exact missing-session error 才換成 new session。取得 final session 的 modes/config options 後，hydrate current model/effort，再完整驗證 saved model、effort、native mode、native permission，依序套用差異。Reconciliation 期間 provider update 不對外發布 capabilities；所有值確認後才回傳 final snapshot。

**Confirmation：** Model、effort 與 native permission 以 `session/set_config_option` 回傳的完整 config snapshot 為權威。Native mode 在呼叫 `session/set_mode` 前先註冊 waiter，接受同 session 的 `current_mode_update` 或 mode-bearing `config_option_update`；值不符、session/connection teardown 或 bounded timeout 都 reject。Waiter 必須先註冊，因為 notification 可能早於 set-mode response。

**Reason：** Copilot replacement session 會帶 provider defaults；若只修 session pointer，model/effort/native selections 仍會遺失。先確定 final session 再對帳，可讓 successful resume 與 missing-session replacement 遵守同一份 project-level selection contract。Suppress intermediate capabilities 則避免 renderer 把 temporary defaults 當成 confirmed state 寫回 project prefs。

**Do not change casually because：** 不要在 `ensureSession` 前套 prefs、不要把 config acknowledgement 當 confirmation、不要遇到任一 warm-up failure仍回傳 partial capabilities。Fresh pre-session auth probe 可以回 `authRequired`；但 final session 已建立後的 validation/apply/confirmation failure 必須 fail initialization，否則會以 ready 狀態掩蓋設定遺失。

**Related：** `agent-config-flow#10`、`agent-providers#45`、`agent-providers#46`、`agent-providers#47`、`contracts/agent-routing`、`architecture/agent-execution`。
