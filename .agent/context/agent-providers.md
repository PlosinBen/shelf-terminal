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
