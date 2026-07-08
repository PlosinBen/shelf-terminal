---
type: context
title: Agent UI
related:
  - architecture/agent-turn
  - contracts/agent-wire-protocol
  - contracts/agent-routing
  - context/agent-core
  - context/agent-config-flow
  - context/agent-providers
---

# Agent UI

> Agent View 的 renderer 呈現層：plan panel、status bar、picker form、事件/store 分離架構、訊息渲染原語。

## agent-ui#1 — Sticky Plan Panel：兩 provider 都接 plan 訊息  ·  [Decision]

**Decision**：AgentView 在 input 上方有個固定 panel，顯示當前 plan/todos 狀態。Backend 透過獨立 `AgentEvent::plan` event + `AGENT_PLAN` IPC channel 覆蓋式更新（不進 timeline；見 `agent-ui#5`）。Replace-semantics（每次直接覆蓋整段內容），content 為空字串時 panel 隱藏。

**兩 provider 接法不同**：
- **Copilot**：`session.plan_changed` 事件 → debounced 呼叫 `session.rpc.plan.read()` → 發 `AgentEvent::plan`
- **Claude**（SDK 0.2.x）：攔截 `TodoWrite` tool_use，把 `todos` 陣列轉 markdown checkbox
- **Claude**（SDK 0.3.142+ 起）：`TodoWrite` 被 `TaskCreate / TaskUpdate / TaskGet / TaskList` 取代，是 delta-by-id 不是 snapshot。Provider 內維護 `tasks: Map<taskId, TaskRecord>` 鏡射 SDK task store，每次 Task* 事件處理完都呼叫 `renderPlan()` 整份重發 `{type:'plan', content:md}` — 對 renderer 維持 snapshot 介面不變
- **Claude**：`ExitPlanMode` 直接用 `input.plan` 字串（兩個 SDK 版本都一樣）
- 兩 provider 的 `/clear` 都要主動發空 plan event 清 panel（Claude 還要 clear `tasks` + `pendingTaskCreates` Map）

**Reason**：
- Plan/todo 是「持續被 mutate 的單一 state」，不適合塞在 chat history 裡（會洗版、看不到當下狀態）— 因此走獨立 event channel 不進 message timeline
- Plan panel 跟 message list 視角互補：panel 顯示 latest，list 顯示 history（tool call 何時被呼叫）
- Replace-semantics 跟兩 provider 的原生語意都吻合（Copilot plan 檔覆蓋；舊 TodoWrite 每次傳完整 list；新 Task* 在 provider 內 cache + 整份重發，對外仍是 replace）

**Do not change because**：
- 不要把 plan 放回 message channel — 是 state update（替換語意）不是 timeline append
- Tool call 不要從 message list 拿掉 — history 視角有用（debug 時看時間軸）
- 不要把 plan panel 做成 collapsible inside chat — 用戶要的是「永遠看得到當前狀態」

## agent-ui#2 — Status bar 內容由 provider 決定，renderer 只渲染  ·  [Decision]

**Decision**：Status bar 的所有「provider 知識」欄位（rate limit、context %、permission mode、effort）改用統一 schema：
- **純顯示欄位** → `StatusSegment = { text, severity? }`，provider 把 label 翻譯、reset 倒數格式化、severity 判斷全包好，renderer 只做 `data-severity` → CSS color 對應
- **Cycle 欄位** → `CycleOption = { value, displayName, severity? }`，provider 決定每個 option 的顯示字 + 嚴重度，renderer 只負責 cycle UX（按鈕點下去切下一個 value）

Severity 是抽象層級：`'normal' | 'info' | 'warning' | 'critical'`，map 到 CSS 顏色集中在 `.agent-status-seg[data-severity="..."]`。

**Reason**：
- Vocabulary 跟 UX 訊號是 provider 領域知識（`five_hour` / `premium_interactions` / `bypassPermissions` 各自的危險程度），散到 renderer 寫 `if rateLimitType === 'five_hour' ...` 就是違反 `agent-providers#1`
- 但 cycle 行為（按一下切下一個）是 UI 互動，硬塞到 data model 裡反而過度抽象 — 所以分兩種 schema：純顯示用 `StatusSegment`，可互動用 `CycleOption`
- 共用 helper（`severityFromUtilization`、`formatResetCountdown`）放 `providers/types.ts`，避免兩 provider copy-paste

**配套**：
- Claude / Copilot 都自己決定 quota label（`5h` / `premium`）跟 severity 邊界（例如 Claude 的 `status: 'rejected'` 即使 utilization 50% 也算 critical）
- 100% 不 cap — overage 真實顯示成 `120%`（Copilot 月配額用爆會超過 100%）
- Permission mode 顯示字也由 provider 決定（`default → ask`、`bypassPermissions` 原樣 + critical 嚴重度）
- Renderer 完全不知道 `five_hour`、`premium_interactions`、`bypassPermissions` 等字串存在

**Do not change because**：
- 不要把 severity 換成 raw color（`'red'` / `'#e06c75'`）— 失去抽象，主題切換時改不到位
- 不要把 cycle 結構也包成 `StatusSegment` — cycle 行為是 renderer 領域，過度抽象沒效益
- 不要在 renderer 寫 quota / mode 的特殊翻譯（例如 `if (mode === 'plan') color = blue`）— 這是 provider 該決定的，severity 已經傳達意圖

## agent-ui#3 — Picker_request 收編 AskUserQuestion / Elicitation 為多題互動 form  ·  [Decision]

**Decision**：`picker_request` 是 agent 主動發起的多題結構化 form 唯一 channel：
- Wire shape：`prompts[]`（N 題）+ per-prompt `multiSelect` / `options[]`；`inputType: 'text' | 'number' | 'integer'` 時 renderer render 自填欄（覆蓋 AskUserQuestion 隱含 Other）
- `PickerResolvePayload`：`{ answers: Array<string | string[]> }` index-aligned 或 `{ cancelled: true }`
- Claude：`canUseTool` 攔 `toolName === 'AskUserQuestion'`，轉 picker_request，SDK output JSON 塞 `{ behavior: 'deny', message }` 餵回 model（GOTCHAS 有 hack 說明 + 回歸測試）
- Copilot：`registerElicitationHandler` 接 ElicitationSchema 7 field types → picker_request prompts

**Do not change because**：
- **不要把 permission 跟 picker channel 合併** — permission 的 "Allow/Deny/Allow and remember" 字串是 app-owned 需 i18n、picker label 是 agent-supplied 不能翻譯；resolve shape 也不一樣（`{behavior, scope?}` vs `{answers}`），合併要寫 adapter。Ownership 邊界從 channel 層退到 field-level discriminator 比分兩個 type 還醜
- **不要在 renderer validate 數字 min/max** — SDK 是仲裁者，validation 失敗 LLM 自己會 re-prompt
- **不要把 AskUserQuestion 加進 disallowedTools 退回純文字** — 我們已有 picker UI 跑完整流程

**驗證資產**：
- `scripts/spike-askuser.ts` — SDK 升級時跑一次驗 canUseTool deny+message hack 仍 work
- `agent-server/providers/{claude,copilot}.test.ts` — wire transformation 單元測試

## agent-ui#4 — Agent View 採事件 / Store 分離架構（InputZone 與 MessageList 間接相依）  ·  [Decision]

**Decision**：AgentView 不該是擁有所有 state 的 god component。正確架構是：

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

**Reason**：承 CLAUDE.md Conventions「sibling 元件間接相依」。具體效益：
- MessageList subscribe store slice → 只在 messages 變化時 re-render，input 打字不波及；不需要手動 memoize 一堆 props
- Tab unmount 才安全：messages 在 store 不在 component state，non-active agent tab 可 unmount 釋放記憶體不掉資料

**為什麼是這個架構而不是其他**：

| 選項 | 為什麼不採用 |
|------|------------|
| 父層 coordinator + 共享 state | 父層 state 變化照樣 cascade re-render，沒解決問題 |
| 直接 props 串 input ↔ messages | 耦合最緊，違反「sibling 不該知道對方」 |
| 純 event bus（messages 也走 event） | event bus 不適合存 state，messages 需要 source of truth |
| 純 store（input 也直接寫 store） | input 直接呼叫 store API，比 event bus 緊耦合；side effect routing 不明 |
| **Hybrid（採用）** | 動作走 event bus、狀態走 store，職責清晰 |

**Do not change because**：
- **不要把 input 跟 MessageList 透過共同父層 state 串** — 父層 state 變化照樣 cascade re-render，沒解決問題
- **不要把 messages 留在 component state、其他搬 store** — tab unmount 會掉資料
- **不要把 handleSend 留在 InputZone** — 違反 CLAUDE.md「side effect 集中 App.tsx」，handler 該在 App.tsx

**Related**：`storage#1`（Per-project storage）。

## agent-ui#5 — Agent Message Type 渲染原語化（9-variant union + Plan side-channel）  ·  [Decision]

**Decision**：`AgentMessage` discriminated union 從「provider 語意命名」（thinking / tool_use / file_edit / intent / slash_response / plan / text / system / error / user）重構成「**渲染原語命名**」9 個 variant，plan 從 message channel 抽出成獨立 AgentEvent。

新 union：
- 純 inline：`reply` / `note` / `system` / `error` / `user`
- 可收合卡片（共用 `FoldBase` interface）：`fold_text` / `fold_code` / `fold_markdown` / `fold_diff`
- **`plan` 不在 union 內** — 走獨立 `AgentEvent::plan` + `AGENT_PLAN` IPC channel → 直接寫 `agentTabStore.currentPlan`，永遠不進 timeline

**Reason**：
- 承 CLAUDE.md Conventions「wire payload 是渲染原語不是 provider 語意」— 舊 union 把 thinking / tool_use / slash_response 等 provider 語意洩漏進 renderer；渲染視角下「可收合卡片」是同個 UI primitive，差別只在 body format
- 新增類似 entity 要新 type：未來加 MCP rich output、custom slash 等都要 variant + builder case + renderer case + CSS class
- 語意洩漏到 settings：舊 `AgentDisplayKey` 是 `thinking|tool_use|file_edit|intent`，使用者要記「Tool Use」對應到哪些工具；新 key 是 4 個 `fold_*`、跟 body format 1:1
- `slash_response` 跟 `tool_use` 結構同形但分兩個 type 是歷史包袱；`file_edit` 成功/失敗用不同 body shape 本來就該共用 fold 殼（這四個舊 type 都已併入新 fold_* 系列）

**Key Q-locked 決策**：
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

**不做 migration**：
- User = developer，IDB 歷史可棄
- Settings 舊 key (`thinking` / `tool_use` / `file_edit` / `intent`) 直接拿掉、不轉換
- IndexedDB version bump v3 → v4，upgrade handler drop old store + 重建

**Do not change because**：
- 不要在 renderer 加任何「if (toolName === ...) special case」分支 — 渲染決策走 type，type 決策已在 provider
- 不要把 plan 放回 `AgentMessage` union — plan 屬性是「替換式 state update」、不是 timeline append
- 不要把 `fold_*` 收回成單一 `fold` type + `bodyFormat: 'text'|'code'|'markdown'|'diff'` discriminator — TS narrowing 變兩層，format-specific 欄位擴充會污染其他 fold 類
- 不要在 renderer 解析 label / content 語意（例如「label === 'Thinking' 就顯示閃爍 caret」）— 動態 affordance 純靠 `streaming` flag + body cursor
- 不要為 errorMessage 也加獨立 setting key — 永遠強制顯示，不暴露關閉選項

**Related**：`agent-config-flow#2`（Slash 內部 dispatch — slash_response type 廢除、改 emit fold_markdown）、`agent-ui#1`（Plan panel — 從 message channel 攔截改成獨立 event channel）。

## agent-ui#6 — App.tsx 解構 useStore() 必須包含所有使用的欄位  ·  [Gotcha]

**Symptom**：`settings is not defined` ReferenceError，app 白屏。

**Root cause**：`const { projects, activeProjectIndex, sidebarVisible } = useStore()` 漏了 `settings`，但後面直接用 `settings.themeName`。在 minified bundle 中變成未宣告的變數。

**Fix**：確保 `useStore()` 解構包含所有後續使用的欄位。

## agent-ui#7 — Not-ready overlay：pane-scoped `absolute`（非 `fixed`）、統一 starting / init-failed / health-dead  ·  [Decision]

**Decision**：pane「還沒 ready」的呈現是一個**蓋在 agent pane 上的 dim+blur overlay + 置中 card**（`ConnectionOverlay`），取代原本「list 頂端一小塊 + `dead` 只在 sidebar 亮個點」的易錯過設計。

**四態統一**：一個 overlay 收編所有 pane 不可用的情況 ——
- init `starting`（first-open **或** reconnect 中）：spinner + phase 文字（`initPhaseLabel(initPhase)` → Deploying / Connecting / Checking sign-in / Starting；dead+starting 時顯示「Reconnecting…」）。first-open init **也蓋**（不再只是 list 內的輕量 spinner —— 那太隱晦，pane 該明確讀作「還沒好」且 input 明顯被擋）
- init `failed`（「Failed to start」+ Retry）
- health `dead`（「Connection lost」+ Reconnect）

guard：只有 `ready` + healthy 才不蓋。phase 文字的單一 source 是 `components/agent/init-phase.ts` 的 `initPhaseLabel`（overlay 用它；MessageList 已無獨立 init-pane）。Retry/Reconnect 走既有 `handleRetryInit`；init ready + health 復原後 overlay **自清**（依賴 reconnect 的 health-seed，見 `connection-health#8` —— 沒 seed 紅燈不清、overlay 不會消失）。

**為何 `absolute` 不是 `fixed`**：overlay 定位在 agent pane 內（`position:absolute` inside `.agent-view`），**不是** viewport-`fixed`。`fixed` 會蓋住 sidebar 或 split 的**兄弟 pane** —— 一個 pane 斷線不該遮住整個 app 或旁邊還活著的 pane。pane-scoped 讓失敗視覺被關在自己的 pane 裡。

**為何 dim+blur 不是 opaque**：blur 讓對話**仍可讀** —— 斷線**不該藏掉歷史**；使用者要能一邊看之前的內容一邊決定 Retry。

**Do not change casually because**：
- 別把 overlay 改成 `fixed` —— 會蓋住 sidebar / sibling split pane（一個 pane 的失敗不該波及全 app）。
- 別把四態拆回各自的小 affordance —— 統一一個 overlay 才不會像舊版那樣被錯過（first-open starting 曾經只有 list 內 spinner，太隱晦）。
- 別把 overlay 改成 opaque / 藏掉對話 —— 斷線 / reconnect 時歷史仍要可讀。

**Related**：`connection-health#8`（reconnect health-seed —— overlay 自清的前提）、`connection-health#7`（兩層 health / reconnect 的失敗來源）、`architecture/agent-dispatch`、`src/renderer/components/agent/ConnectionOverlay.tsx`。
