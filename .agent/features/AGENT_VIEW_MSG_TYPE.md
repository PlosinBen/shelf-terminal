# Agent View Message Type Architecture

## 背景

Renderer 顯示 agent 訊息的詞彙原本散落在三層（provider 端 ad-hoc string、main 端 union、renderer 端另一個 union），加新 SDK event 要動 3-4 個檔案且沒 type safety 把關。Wire protocol 是 `[key: string]: unknown` free-form，main 端用單一覆寫式 `lineHandler` 接 stdout，沒有 turn 邊界保護 → 緊湊送訊息（queue flush）會踩跨 turn event leak。

兩輪重構解掉這些：

1. **Canonical AgentMessage refactor** — 把 message 詞彙統一到 `src/shared/types.ts` 的 discriminated union；provider 變翻譯層；renderer 走 exhaustive switch
2. **P1+P2 wire protocol overhaul** — 每個 per-turn event 帶 `turnId` envelope，main 端 turn-dispatcher 路由；stream + message 合進單一 upsert pipeline（msgId 配對）

---

## 設計原則

### 1. 拆 type，不拆內部 kind

`tool_use` 跟 `file_edit` 是平行的 canonical type，不是 `tool_use` 內部用 `kind: 'generic' | 'edit'` 分。讀 union 一覽無遺，TS exhaustiveness 自然，renderer dispatch 一個 switch 結束。深層分流是反模式。

新需求若偏離「input / output 兩塊」（譬如 sub-agent markdown 結果），升格成獨立 canonical type，**不要**回去 `tool_use` 偷加 toolName 分支。

→ DECISIONS.md #52

### 2. Result 內嵌

`tool_use.result?` / `file_edit.result?` 同個 toolUseId 的後續 message upsert 覆蓋。Canonical type 對應「一個 UI 卡片」而非「一條 wire 事件」，pending state 是免費的（`result === undefined`），不需要獨立 `tool_result` type。

### 3. `tool_use.input` 是字串而非 object

Provider 翻譯時就把 SDK 的 structured input 攤平成「人能讀的單行字串」，renderer 把它當不透明文字渲染（只做 CSS 截斷）。

實作：
- Claude: `agent-server/providers/claude.ts:formatClaudeToolInput`
- Copilot: `agent-server/providers/copilot.ts:formatCopilotToolInput`

收益：renderer 不認 SDK 詞彙（`Bash` / `bash` / `view` / `Read` …），不再有 `getToolSummary` / `ToolBody` 兩條 helper 各自 switch on toolName 的反模式，新 SDK tool 只動 provider formatter 一張表。

### 4. Wire 帶 `turnId` envelope；main 端按 turnId 路由

每個 per-turn event 由 `wrapSendForTurn(turnId, send)` 自動 stamp turnId。Main 端 `createTurnDispatcher` 取代覆寫式 lineHandler，按 turnId 路由到 per-turn AsyncGenerator。Turn 結束後 generator unregister，殘留 event 找不到接收者就 drop。

設計細節（為什麼 protocol-level 路由勝過 provider-side dedup、turnId 格式、配套 envelope）：

→ DECISIONS.md #53

### 5. Stream + message 走同一個 upsert pipeline

Provider 為每個內容 block 生 `msgId`，stream chunks 跟 finalize message 共用同一個 id。Renderer 不再維護獨立 `streamText` / `streamThinking` state — 所有訊息進 `messages` 陣列，按 msgId upsert。In-flight entry 帶 `streaming: true` flag，cursor 渲染在 message 級。

`msgId` 與 `toolUseId` 合併：tool 訊息上 `msgId === toolUseId`（同一個身份識別碼，兩個 named 欄位是因為 permission_request 仍按 toolUseId pair）。

### 6. Persistence

- `saveAgentMessages` 寫入前 filter 掉 `streaming: true` 的 entry（中斷的 turn 不留半截）
- `loadAgentMessages` 對「有 toolUseId 但無 result」的 tool_use / file_edit 補一個 synthetic failed result（`reviveOrphanPending`），避免重開 app 看到永久 pending 卡片
- 舊版 wire 用 `toolInput: object`，load 時若新 `input` 字串缺席就 JSON.stringify 一次性遷移（`migrateLegacyToolUseInput`）

---

## Canonical types — 何處查 source of truth

| 詞彙 | 檔案 |
|------|------|
| `AgentMessage` discriminated union | `src/shared/types.ts` |
| Wire `OutgoingMessage` discriminated union | `agent-server/providers/types.ts` |
| Renderer `AgentMsg`（加 `user` variant + `id`/`provider`/`timestamp`） | `src/renderer/components/AgentMessage.tsx` |
| Renderer dispatch（exhaustive switch + `_exhaustive: never`） | `src/renderer/components/AgentMessage.tsx` |
| Turn dispatcher | `src/main/agent/turn-dispatcher.ts` |

---

## Renderer 模型概覽

```
agent-server provider
  ├─ wrapSendForTurn(turnId)  ← 每個 per-turn event 自動帶 turnId
  ├─ wrapSendForContext       ← context_patch 攔截不轉發
  └─ raw stdout

main / remote.ts
  └─ createTurnDispatcher     ← 按 turnId 路由
       └─ per-turn AsyncGenerator → dispatchEvent → IPC

renderer / AgentView.tsx
  ├─ onMessage  → buildAgentMsg → upsertById(messages, ...)
  ├─ onStream   → 同 msgId 找 entry, append delta, streaming=true
  └─ onStatus(idle) → 把 streaming:true 都改 false

renderer / AgentMessage.tsx
  └─ switch on type, exhaustive narrowing
```

---

## 進一步閱讀

- `.agent/DECISIONS.md` #52（tool_use input/output 字串對）
- `.agent/DECISIONS.md` #53（wire envelope + turn routing）
- `.agent/GOTCHAS.md`「Queued message flush」（歷史 race，turn-dispatcher 修法）
- `.agent/PROJECT_MAP.md`（每個檔案的職責）

## 仍未做（保留紀錄避免回頭被誤勸）

- `intent` UI marker 樣式微調 — 等實際使用觀察再回來
- `file_edit` large file diff 折疊 — 沒踩到痛點不做
- `task` / `Agent` markdown render — 若真痛了升格獨立 canonical type，**不要**回 tool_use 加分支
- Plan panel 從 sticky 改 timeline — 沒痛點不動
- Delete 操作（apply_patch 內）— 需新 canonical type 或 file_edit 加 deleted flag
