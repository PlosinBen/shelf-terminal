---
type: context
title: Agent Config Flow
related:
  - architecture/agent-turn
  - contracts/agent-wire-protocol
  - contracts/agent-routing
  - context/agent-core
  - context/agent-providers
  - context/agent-ui
---

# Agent Config Flow

> Agent turn 的 wire envelope（per-event turnId）、slash 命令的 provider-internal dispatch，以及 model / effort / permission 三個 config knob 從 renderer 發起 → provider 套用 → capabilities 廣播落地的單向流動。

## agent-config-flow#1 — Wire protocol envelope: per-event `turnId` 做 main 端 turn 路由  ·  [Decision]

**Problem**：舊 `OutgoingMessage` 是 free-form `[key: string]: unknown`，沒有 envelope 標識「這個 event 屬於哪個 query turn」。`src/main/agent/remote.ts` 用單一 `lineHandler` setter 接收 stdout — 每個新 query 上來覆寫前一個的 handler。當 agent-server 在 turn N 結束後**延遲**發出 event（譬如 claude.ts `result` handler 發完 idle、`finally` block 又補一次），這個 leftover event 會被 turn N+1 剛裝好的 handler 吃掉，誤判成自己的 idle → for-await 立刻結束 → turn N+1 真實 events 沒人讀（queued msg bug 的根因）。

**Decision**：每個 per-turn wire event 帶 `turnId: string` envelope。

- Main 端在 `query()` 入口生成 turnId（`t-${randomUUID().slice(0, 8)}`），透過 IPC `send` payload 餵給 agent-server
- agent-server 的 `handleSend` 從 incoming msg 拿 turnId（缺則 fallback 新生），用 `wrapSendForTurn(turnId, send)` 包 send 函式 — 自動在所有 outgoing event 上 stamp turnId
- Provider 完全不感知 turnId（透過 closure 帶過去）
- Main 端的 `createTurnDispatcher`（`src/main/agent/turn-dispatcher.ts`）取代舊 `streamRemoteEvents`：單一全域 stdout listener 按 turnId 路由到 per-turn `AsyncGenerator`，turn 結束後 unregister；任何後續帶舊 turnId 的 event 找不到接收者就 log + drop
- Lifecycle events（`ready` / `pong` / `capabilities` / `credential_*`）在 turn 外部，turnId 是 optional — 由 requestId 或單一 dispatcher 處理

**配套 envelope**：`AgentMessage` / `stream` payload 另帶 `msgId`（per-message-block 識別碼，不同於 per-turn 的 turnId），讓 stream chunks 跟 finalize 在 renderer 對齊到同一 timeline entry（store 上的 upsert key）。`OutgoingMessage` 同時從 free-form 收緊成 discriminated union。

**Do not change casually because**：
- 不要為了 backward-compat 加 fallback「沒 turnId 就分配給 currentTurn」— 這正是舊 single-lineHandler 模型的 bug 來源
- 不要在 provider 端 dedupe idle — turn-dispatcher 已從根上擋下，不需要二次防線
- 不要把 turnId / msgId 暴露給 renderer-side `AgentMsg.id` 以外的用法 — 它是 store 的 upsert key，不該洩漏到 UI 行為決策（如「if id starts with t- 就...」）

## agent-config-flow#2 — Slash commands: provider-internal dispatch，不是 RPC channel  ·  [Decision]

**Decision**：Slash 是 provider 想特別解釋的字串，**不是獨立 channel**：

- Renderer 不偵測 slash — `agent.send(text)` 一條路徑通吃普通 text 跟 `/cmd`（config picker 走 `agent-config-flow#3` / `agent-config-flow#5` 的結構化 config-edit turn，是「按鍵級 config edit」不是 agent command）
- Provider 在 `query(input, send)` 入口呼叫 `parseSlashPrefix(input.prompt)`，命中走內部 `dispatchSlash(cmd, args, send)`
- Slash 輸出走 `fold_markdown` 渲染原語（label 是 `/cmd` 名、失敗用 `errorMessage`；見 `agent-ui#5`）
- Backend interface 只剩 `query(input, send)`，沒有 `handleSlashCommand`

與 `agent-ui#5` 一致：renderer 給框、provider 給內容。Lifecycle 對齊：slash 在外部就是個 turn，streaming → idle，跟 `queuedMessages` queue 邏輯共用、不需插隊。

**Stop 行為**：`stoppable` flag 是 provider-internal、不上 renderer（業界共識：stop 按鈕永遠在、能不能停由 provider 決定）。`/compact` 整個 SDK turn、`/clear` 的 dispose+rebuild 都用 `critical()` helper 包成 non-stoppable，stop() silently no-op（避免 SDK 卡在 half-compacted state）。

**Do not change casually because**：
- 不要把 SlashResult / slash_command RPC 通道復活 — 那條路就是這次砍掉的對象
- 不要為了 fast-path 給 `/help` 開特例（不走 `query()`）— 統一 lifecycle 比省幾 ms 重要
- 不要把 slash 偵測搬到 orchestrator 或 main 端 — 違反「provider 自主決定要不要解釋 prefix」（未來 Claude 想加 `\help` 之類也行）
- 不要在 renderer 加「stoppable」UI 狀態 — 加了就回到 RPC 心智模型、違反 message stream 一致性

## agent-config-flow#3 — Slash command routing + prefs flow  ·  [Decision]

**默認規則**：所有 slash 都送 provider — 不管 provider 認不認得。Renderer 只在一種情境內留手：`OPTIONED_SLASHES`（`/model` `/effort` `/permission`）**無 args** 時開 inline picker 從 capabilities 取選項（省一趟 backend 來回）。其他狀況一律 fall through 給 provider。

### 流程

```
user types "/cmd [args]"
    ↓
InputZone parseSlashPrefix
    │
    ├─ cmd ∈ OPTIONED_SLASHES && !args
    │     → 開 inline <SelectionPanel>（從 capabilities 取選項）
    │       picker 選定 → handleConfigEdit → 結構化 config-edit turn（agent-config-flow#5）
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

- 打字 slash with args 走 provider slash（如上圖）；picker / status-bar 走結構化 config-edit turn（`agent-config-flow#5`）。兩者最終都到 provider `applyConfigEdit` → re-broadcast capabilities，**無 renderer 樂觀更新**
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

- 不要把 prefs 改回「renderer optimistic apply + 不問 backend」— bug 來源（dirty state 落地 + status bar 跟 backend 不一致）
- 不要在 renderer 端攔截「unknown command」— 該讓 provider 回，user 才知道 slash 被 dispatch；renderer 攔截 = provider-specific slash 死路
- 不要在 renderer 加 model validation against capabilities — SDK 是唯一仲裁者（Claude `supportedModels()` 會隱藏但實際接受 legacy models）
- 不要在 provider 內 setX 做 diff — orchestrator 已做
- 不要在 capabilities-driven persist 加 throttle/debounce — capabilities event 自然就是「有變化才 broadcast」，下游沒 spam 風險

## agent-config-flow#4 — Model 顯示：intent-driven，alias 不被 per-turn 解析值覆蓋  ·  [Decision]

**Background**：Claude SDK 0.3.x 的 `supportedModels()` 回傳的是「推薦 alias」清單（runtime 拿、非寫死）：`default`（= recommended，現為 opus 4.8）/ `sonnet` / `haiku`。**清單裡沒有 `opus`**。使用者選 alias 後，SDK 每個 turn 回報的 `message.model` 是解析後的具體 id（如 `claude-opus-4-8`，init 甚至帶 `[1m]` 標記）。

**Problem**：舊邏輯把 per-turn 解析的具體 model 經 status 事件灌進 `actualModel`，導致 flip-flop：選 `default` → query 後顯示 `claude-opus-4-8` → 重啟又變 `default`。

**Decision**：status bar 顯示的 model 是 **intent**（使用者選的），由 capabilities channel + intent seed + 明確 edit 驅動，**per-turn status 不帶 model**。再依 intent 性質分流：

- **intent 是 alias（在 `supportedModels()` 清單內）** → 永遠顯示該 alias，不被解析值覆蓋。`default` 維持「跟著 recommended 走」語意，不 pin 死、重啟一致。
- **intent 不是 alias（使用者 pin 了具體 / custom id）** → 採用 SDK 實際回報的 model，promote 到 `currentModel` 並重發 capabilities → 顯示 + project config 都更新成實際 model。

判斷邏輯抽成 pure helper `shouldAdoptResolvedModel(resolved, currentModel, aliases)`（claude.ts），query loop 呼叫。守備：synthetic `<...>` 跳過、unchanged no-op、`currentModel` 未設視為 unpinned 不 promote、alias 清單未填（warmup 未完）不 promote 避免誤判。

**為何不 pin alias**：
1. `default` 字面意思就是 recommended — pin 死等於放棄追新（4.9 出來跟不上）
2. 解析 id 帶 `[1m]` 等標記，不保證是合法 `--model` 輸入，餵回 API 可能壞
3. 清單沒 `opus`，選 alias 是「我要推薦的」不是「我要這個特定版本」

**Do not change casually because**：
- `setStatus` 不要再加 model 欄位 — 顯示走 capabilities，避免 per-turn 覆蓋
- 不要在 renderer 判斷 alias vs 具體 id — provider 有 `cache.models`（SDK 清單）才是權威，renderer 的 `capabilities.models` 含 custom models 會誤判
- 不要為了「想看 default 實際跑哪版」把解析值 persist 進 `agentPrefs.model` — 那會 pin 死 alias；要顯示就走 annotation（另開 `resolvedModel` 欄位，未實作）

**Related**：`agent-server/providers/claude.ts:shouldAdoptResolvedModel` + query loop promotion；SDK `init.model` 是解析後具體 id（帶 `[1m]`）不是 alias。

## agent-config-flow#5 — Config 變更統一走 provider applyConfigEdit（職責歸位）  ·  [Decision]

model/effort/permission 三個入口（打字 `/model X`、picker、status-bar 點擊）都收斂到 provider 的 `applyConfigEdit`（set value + emit capabilities + emit `system` divider，文案 `src/shared/config-ack.ts`）。打字走 `query()` parseSlash；picker/status-bar 走 `handleConfigEdit` emit 結構化 config-edit turn（`agent:send` 帶 `configEdit:{key,value}`、無 echo）→ `QueryInput.configEdit`。

本質是把 config 變更的語意還給 provider，renderer 不再 renderer-local 樂觀模擬（取代 `agent-config-flow#3` picker 那條 renderer-local 路）。

**Do not change casually because**：
- 不要在 `handleConfigEdit` 加回樂觀 `setActual*`/`persistPref` — 會跟打字的 round-trip 行為分歧。顯示/持久化一律由回傳的 capabilities 驅動
- renderer 送結構化 `{key,value}`，不要組 `/model X` 字串（slash 語法留在 provider）；也不要為 config-edit 開新 IPC（它是 turn，重用 send/turn 路由）
- `applyConfigEdit`（明確變更，有 divider）≠ `setModel`/`setEffort`（orchestrator 每訊息的 silent pref-diff，無 divider）

## agent-config-flow#6 — Config 套用職責邊界：能塞給 SDK 就塞，不擴張權責（model / effort / permission 同一套）  ·  [Decision]

**Background**：曾為修「Copilot 卡在外來 model id（`claude-opus-4.8` 漏進 `agentPrefs.copilot`）每回合報 not available」而在 provider 加自訂驗證（比對 `listModels()` 擋未知 id）。判定為**擴張 provider 職責**後撤回。延伸 `agent-config-flow#3`「不要在 renderer 加 model validation」到 provider 端，並把 model/effort/permission 收斂成同一條原則。

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
- **差異只在 backend apply 收斂點**（本質差異，勿為對稱強行統一）：Claude → `applyConfigEdit`（`agent-config-flow#5`，純 set+emit）；Copilot → `query()` 把 `QueryInput.configEdit` 路由進 `dispatchSlash`（`permissionMode`→`/permission`）。**漏路由會 fall through 成空 prompt → 沒卡片、接續上次對話**（曾經的 bug）。
- 兩邊 config-edit 成功都 emit `system` divider（共用 `formatConfigAck`，「applies on next query」對兩邊都成立）；Copilot 失敗 emit `error`。`/help`/`/clear`/`/context`/`/compact` 仍是 `fold_markdown`（slash 內容輸出，非狀態轉換）。

**Do not change casually because**：
- 不要在 `gatherCapabilities`/`setModel`/`dispatchSlash` 加「model 是否在 `listModels` 清單內」的前置拒絕 — 交給 SDK，錯誤照實回。
- 不要把 app→SDK 翻譯表抽成跨 provider 共用 helper（假複用）；共用的只有 app 詞彙 list（`PERMISSION_MODES`）。
- 不要把兩 provider 的 config-edit apply 抽成跨 provider 共用函式 — apply 語意本質不同，只共用 `formatConfigAck` 文案與 wire 形狀。
- 不要在 renderer 為 copilot/claude 分流 config-edit — 分層邊界在 backend。

**Related**：`agent-config-flow#3`（slash routing + prefs flow）、`agent-config-flow#5`（config-edit 收斂）、`agent-config-flow#4`（model 顯示 intent-driven）、`agent-server/providers/{claude,copilot}/index.ts`、`agent-server/providers/types.ts`（`PERMISSION_MODES`）、`src/shared/config-ack.ts`。
