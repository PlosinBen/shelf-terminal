---
type: context
title: Agent Config Flow
related:
  - architecture/agent-execution
  - contracts/agent-wire-protocol
  - contracts/agent-routing
  - context/agent-core
  - context/agent-providers
  - context/agent-ui
---

# Agent Config Flow

> Shelf execution 的 control envelope、session-scoped content delivery、slash 命令的 provider-internal dispatch，以及 model / effort / permission 三個 config knob 從 renderer 發起 → provider 套用 → capabilities 廣播落地的單向流動。

## agent-config-flow#1 — `executionId` 只路由 control；content 走 session sink  ·  [Decision]

**Problem**：單一 stdout handler 會讓前一個 request 的晚到 control 被下一個 request 誤收；若進一步把 conversation content 也綁到 request boundary，execution settlement 後到達的 final message 或 tool result 就會被當成 orphan 丟棄。

**Decision**：Shelf 把「一次 accepted send 的本地控制生命週期」命名為 execution；它不是 ACP 或 provider protocol 定義的 turn。

- Main 在 `query()` 入口生成 `executionId`（`e-${randomUUID().slice(0, 8)}`），在 send 抵達 agent-server 前註冊 `ExecutionDispatcher` reader。
- `status`、permission 與必要 control 帶 `executionId`；terminal idle 結束 reader、清 permission、更新 busy state並釋放下一個 queued send。
- `message`、`stream`、renderable `error` 與 `task_event` 經 `wrapSendForExecution` 時明確移除 `executionId`，由常駐的 per-session `onSessionEvent` sink 送到 tab。execution settlement 不關閉這條路。
- Lifecycle/RPC events（`ready` / `pong` / `capabilities` / `credential_*`）依各自的 session sink 或 `requestId` 處理。
- Provider 不需要感知 `executionId`；provider-native turn/cycle 可以保留自己的名稱與語意。

**Content identity**：`msgId` 與 `executionId` 無關。renderer 第一次看到新 `msgId` 就依到達順序 append；重複 `msgId` 就地 upsert，並由 renderer 單獨累積 stream delta。idle 只把當下內容 settle/persist；之後晚到的 chunk 仍照常顯示、保持 settled 並立即持久化。

**Do not change casually because**：
- 不要加「沒 executionId 就歸給 current/last execution」的 fallback，也不要用 grace timer、drain barrier 或 prompt attribution 推測內容歸屬。
- 不要用 terminal idle/stop reason 關閉 content sink；它只控制 execution settlement 與 queue unlock。
- 不要讓 renderer 依 `executionId` 分組、決定訊息可見性或 key DOM；renderer 只使用 `msgId` 做 append/upsert。

## agent-config-flow#2 — Slash commands: provider-internal dispatch，不是 RPC channel  ·  [Decision]

**Decision**：Slash 是 provider 想特別解釋的字串，**不是獨立 channel**：

- Renderer 不偵測 slash — `agent.send(text)` 一條路徑通吃普通 text 跟 `/cmd`（config picker 走 `agent-config-flow#3` / `agent-config-flow#5` 的結構化 config-edit turn，是「按鍵級 config edit」不是 agent command）
- Provider 自己決定如何解釋 slash：Claude 在 `query()` 內 parse/dispatch；Copilot 交給 ACP CLI；Codex 在 app-server backend 將 Shelf-supported slash 映到對應 JSON-RPC route，unsupported route 明確回錯。
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
- Copilot（ACP）：model/effort 仍直接對 live ACP session 套用；permission UI 改走 provider-native mode + `allow_all`，不再參與 canonical pref flow（`agent-config-flow#9`）
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
- **值沒變＝完全 no-op**：送出的值 === 現行 closure 時 provider直接 return，不 emit divider、capabilities、status streaming/idle；各 backend在自己的 apply入口維持此 guard。

## agent-config-flow#6 — Config 套用職責邊界：能塞給 SDK 就塞，不擴張權責（model / effort / permission 同一套）  ·  [Decision]

**Background**：曾為修「Copilot 卡在外來 model id（`claude-opus-4.8` 漏進 `agentPrefs.copilot`）每回合報 not available」而在 provider 加自訂驗證（比對 `listModels()` 擋未知 id）。判定為**擴張 provider 職責**後撤回。延伸 `agent-config-flow#3`「不要在 renderer 加 model validation」到 provider 端，並把 model/effort/permission 收斂成同一條原則。

**統一原則（判準是「SDK 有沒有 apply 的 func」，不是「誰擁有 namespace」）**：
- **SDK 有 imperative apply func → 直接塞給它**，SDK 自己就是 validator，成功就用、**失敗照實 emit error**。不自己前置驗證。
- **SDK 沒有（值只能透過下次 query 的 options 生效，如 Claude）→ 只記 closure、defer 到下次 query**，由 SDK 收到 option 時判定。不為了「當下就驗」而擴張權責。
- 不維護自家白名單前置拒絕 model——清單（`listModels()`）會落後 GitHub 實際支援（例：opus 4.8 已上線但 `listModels` 還沒列，前置擋會誤殺）。「卡在外來 id」靠 SDK 報錯 + 使用者改選（picker 只列合法值）復原。

**三個 knob × 三個 provider**：

| knob | Copilot（ACP） | Codex（app-server） | Claude（per-call options） |
|------|------|------|------|
| model | `driver.setConfigOption(configId('model'), value)` | backend closure 套到下一個 app-server turn/thread config | 記 closure，下次 query `options.model` 由 SDK 驗 |
| effort | `driver.setConfigOption(configId('thought_level'), value)` | backend closure 套到下一個 app-server turn config | 同上 |
| permission | native mode 用 `driver.setMode(value)`；native permission 用 `driver.setConfigOption('allow_all', value)` | 映成 approval policy + sandbox policy | 記 closure，下次 query `options.permissionMode` 由 SDK 驗 |

（cutover 後 copilot 走 ACP：以上 native SDK 的 `session.setModel`/`session.rpc.mode.set` 已刪。）

**翻譯 adapter ≠ 驗證**：
- Shelf strategy 的 app 對外詞彙（permission list）是**共用單一來源** `PERMISSION_MODES` / `PermissionModeId`；Claude/Codex 各自翻譯或套用。
- Native strategy 不做 canonical 翻譯；opaque value 必須在 provider advertise 的 options 中往返。Copilot 的 mode 與 `allow_all` 各自交給 ACP 驗證。
- SDK 拒絕或 advertised state 不合法就照實 emit error；不可跳過 SDK action 卻回報成功。

**Renderer / Backend 分層（回應「picker 兩邊行為是否不同」— 不同只在 backend）**：
- **Renderer 對 provider 無感、單一路徑**：picker/status-bar/無參數 `/model` → `handleConfigEdit` → `agent:send{configEdit}`；手打 `/model X` → 普通 prompt。
- **差異只在 backend apply 收斂點**：各 provider在 `query()` 見到 `QueryInput.configEdit` 時走自己的 `applyConfigEdit`，依 transport套用或記住下一回合設定。
- config-edit成功都 emit `system` divider（共用 `formatConfigAck`）；失敗 emit `error`。

**Do not change casually because**：
- 不要在 `gatherCapabilities`/`setModel`/`dispatchSlash` 加「model 是否在 `listModels` 清單內」的前置拒絕 — 交給 SDK，錯誤照實回。
- 不要讓 Copilot native permission 回流 canonical `PERMISSION_MODES`；strategy boundary 見 `agent-config-flow#9`。

## agent-config-flow#7 — Init readiness gate：caps RPC fail-closed，input 鎖到 `init 'ready'`（不 queue）  ·  [Decision]

**Background**：`gatherCapabilities` 在 tab-open 關鍵路徑上做慢速外部呼叫（Copilot：spawn CLI subprocess + `getAuthStatus` + `listModels`→GitHub，正常 ~3s，偶發 stall >30s）。main↔child 的 `get_capabilities` RPC 有 30s timeout。舊行為兩個雷：timeout **`resolve` 一包空 caps**、error payload **被忽略照樣 resolve 空**——都靜默，且 main 的 `.then` 照跑 → `init_status='ready'`。結果：status bar 全空、model picker 空，但 **pane 看似 ready、input 可送**（假可用）。

**Decisions**：
- **caps RPC fail-closed**：`remote.ts` getCapabilities 的 **timeout 與 error payload 都 `reject`（不再 resolve 空 caps）** → 流進 `startSession` 現成 `.catch` → `init_status='failed'` + reason → MessageList 顯示 Retry。**為什麼 fail-closed**：caps RPC 走的 `ensureClient`（spawn CLI）**與 turn 共用**，timeout 無法區分「只是 listModels 慢（turn 仍可用）」與「CLI hung（turn 也死）」；健康度不明時**寧可鎖住也不假裝可用**。（`getAuthStatus`/`listModels` 是 init 專屬、turn 不碰；但 spawn 共用 → 保守。）此舉**回歸** `remote.ts` 原註解本意「失敗時 throw 而非回空」。
- **Input readiness gate**：`InputZone` submit 鎖在 `tab.initStatus === 'ready'`；非 ready（`starting`/`failed`）時 textarea `disabled` + 誠實 placeholder，`handleSend` early-return。**不 emit、不進 queue**——queued 隱含「稍後一定送得出去」，init 未確立給不了此保證。ready event（`init_status`）就是解鎖訊號，不用另造 event。
- **fail-loud**：兩條 silent-empty 路徑現在 `log.warn`（`agent-remote` tag，帶 reqId + reason），不再無聲吞掉。

**Do not change casually because**：
- 不要把 timeout 改回 `resolve(空 caps)`「讓 UI 至少顯示點東西」——那正是假可用 + 讓訊息 queue 進未確立的 backend 的來源。要嘛 reject（現況），要嘛未來把慢的 `listModels` 移出關鍵路徑（背景載入）讓 ready 快而可靠。
- `checkAuth` 已 `try/catch → false`，getCapabilities reject 是**既有設計預期**（`remote.test.ts` 已斷言），不是回歸。
- E2E 靠 fake provider 的 `SHELF_TEST_CAPS_FAIL` env（`capsFail` fixture option）驅動 failed-init；**不要**改成用 provider name 分派 fail backend —— 會撞 `agent-deploy-copilot`/`-mcp` 這些在 SHELF_TEST_MODE 下開 Copilot tab 且預期成功的既有測試。
- 不要把 provider 的 config-edit apply 抽成跨 provider 共用函式 — apply 語意本質不同，只共用 `formatConfigAck` 文案與 wire 形狀。
- 不要在 renderer 依 provider 分流 config-edit — 分層邊界在 backend。

**Related**：`agent-config-flow#3`、`agent-config-flow#5`、`agent-config-flow#4`、`agent-server/providers/{claude,copilot,codex}/index.ts`、`agent-server/providers/types.ts`、`src/shared/config-ack.ts`。

## agent-config-flow#8 — Dispatcher model cache：cache-aside + TTL-only；caps per-sid 在 session_ready 之後  ·  [Decision]

> 適用於 dispatcher 路徑（`architecture/agent-dispatch`），現為預設。model list 的 ~1.3s `listModels`（唯一走網路的 caps 呼叫）從 per-session 各自 fetch，改由 **per-host dispatcher** 快取跨 session/跨 project 共用。舊 per-session 直連 path 以 flag 保留為**過渡 fallback**（移除已列管）。

**Cache home = dispatcher，不是 client**：cache 住在 dispatcher（比任何 exec 都長命 —— exec per session 生滅，per-host front 常駐）。第一個 exec fetch → write-back 到 dispatcher；後續 exec（甚至同 host 上不同 project）從 dispatcher 讀到 → 真正跳過那趟 `listModels`。跨 project 共用成立是因為 **cache 生命週期與 exec 生命週期解耦**，不是因為 exec 互通。

**Cache-aside（dispatcher 是被動 store，Redis 式）**：exec miss → 問 dispatcher → dispatcher 只回 hit/miss，**自己不 fetch**；miss 時 **requester（exec）自己** 用自身 provider capability fetch，再 write-back。dispatcher 保持 dumb passive store（對齊「broker 不做重活」）。無跨 exec lock：同時 cold-open 各 fetch 一次，write-back idempotent、last-writer-wins 無害（YAGNI）。

**Freshness = TTL ONLY（account-guard 不可行）**：本想用 account-identity 當即時失效（換帳號 → 立即 bust），但 **Copilot `getAuthStatus` 不暴露 per-account identity**（只有 isAuthenticated / authType / host）→ account-guard 建不起來。所以同 host 換帳號的 stale 只能 ≤ TTL（罕見、已知取捨）。TTL 是 cache 的**內在屬性**（任何 entry 都得定義「多舊算太舊」），不是 models 專屬 hack：entry `{ value, account, fetchedAt }`，`cache_get` 只在存在且 `now - fetchedAt < TTL` 才回 hit（過期 → 當 miss + evict）；`fetchedAt` 用 dispatcher 自己的時鐘（讀寫同鐘、無跨機 skew）。TTL 為何**必要**而非 YAGNI：一次性 blocking init（`agent-config-flow#7`）讓一個 tab 的 model list **凍結整個生命週期**（init 後不再 refetch）→ 無 TTL backstop 會 frozen-for-life；TTL（default 粗粒度 ~1h）把最壞 staleness 上界住。

**只快取 model blob**：dispatcher 存的是 provider 不透明 blob（passive，不解析；只有 provider 序列化/反序列化）。主要惠及 **Copilot**（唯一 ~1.3s 網路 `listModels`）；Claude 的 model list static/無網路 → cache 對它 moot，沒關係（provider-agnostic infra，不 fetch 的 provider 就不用它）。permissionModes / effortLevels / slashCommands static/便宜、authRequired / current* session-specific —— **都不快取**。cache HIT 只省 `listModels`，**不省** `ensureClient`（spawn CLI）+ `getAuthStatus`（~1.8s 仍跑）。

**Caps ordering：per-sid，在 session_ready 之後**。`get_capabilities` 是 per-`sid` 且在 `open_session → session_ready → get_capabilities(sid)` 之後，由該 sid 的 **exec runtime** 回答（auth probe + dispatcher cache），**不是** dispatcher 回答（保持 dispatcher thin）。這取代舊的「tab-open 時無 session、caps 順帶 lazily spawn proc」流程。

**Do not change casually because**：
- 別把 cache 搬回 client / `state.models` 當真相源 —— 只有 dispatcher 這層能跨 exec 共用（含不可 multiplex 的 provider）；client 端最多是冗餘副本。
- 別加 account-guard 假裝即時失效 —— Copilot `getAuthStatus` 給不出 per-account identity，建不起來；靠 TTL 是刻意取捨。
- 別移除 TTL 想「只靠 account-guard」—— 一次性 blocking init 會 frozen-for-life，TTL 是唯一 backstop。
- 別讓 dispatcher 去 fetch（delegate/orchestrate）—— 破壞 cache-aside 的 passive-store 性質，把重活塞進該保持 thin 的 front。

**Related**：`agent-config-flow#7`（一次性 blocking init → 為何需要 TTL）、`connection-health#7`（cache side-channel 跟 pong 一樣被 dispatcher peek、不 relay 到 main）、`contracts/agent-wire-protocol`（Boundary 2 `cache_get`/`cache_reply`/`cache_put`）、`architecture/agent-dispatch`。

## agent-config-flow#9 — Canonical 與 native permission 是互斥 flow  ·  [Decision]

Provider 以 capability strategy 選一條路：

- `shelf`：沿用 `permissionModes` / `currentPermissionMode`、`permissionMode` config edit、per-message pref diff 與 confirmed-capability persistence。
- `native`：capability 帶專用 mode/permission descriptors；renderer 送 `nativeMode` / `nativePermission` config edit。值不進 `AgentPrefs`，agent-server 不用舊 `permissionMode` seed、reapply 或 writeback。

Native descriptor 是 session truth。ACP notification 可在沒有 active execution 時到達，因此 execution-less `capabilities` 必須走 session sink；收到 provider update 或完整 set-config response就用完整 snapshot 取代舊 state，不自行 merge 猜測。UI 顯示 provider option label/current value，只有 edit request 走既有 structured config-edit turn。

**Do not change casually because：** 不要同時 expose canonical 與 native permission controls；不要把缺少的 native control補成 Shelf default；不要把 native value 存進跨 session pref。Renderer 只判 strategy/descriptor，provider identity 與 ACP vocabulary 留在 backend。

**Related：** `agent-providers#45`、`contracts/agent-routing`、`contracts/agent-wire-protocol`、`architecture/agent-execution`。
