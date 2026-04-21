# Engine Persistence — Design Plan

> Status: **Draft**（尚未實作，實作前需 review）
> Scope: Copilot / Gemini 等走 `src/main/agent/engine/` 的 OpenAI-compatible provider。Claude 已透過 SDK `resume` 做到（見 AGENT_SDK_INTEGRATION.md）。

## Problem

Claude 側的持久化已經透過 SDK `resume` + `providerSessionIds` 做到：使用者關掉 Shelf 再打開，Claude tab 的 session 會自動接續。但 engine providers（Copilot / Gemini，走 OpenAI Chat Completions 相容介面）目前有兩個結構性缺陷：

1. **無 server-side session** — Chat Completions API 是 stateless，每次請求要把整個 history 重送。關掉 app 後，engine 的 in-memory `messages[]` 直接遺失，重開必定從零開始。
2. **無 auto-compact** — history 在 engine 內以 array 形式無限累積，大範圍搜尋（grep、listDir）或長對話會炸 context。目前只有手動 `/compact` slash command。

結果是：engine tab 的對話無法跨 app 重啟存活，也缺乏自動瘦身的機制。

## Design Decisions

使用者已拍板（B/B/B）：

### D1. Engine 自己實作 sessionId（Lazy 產生）

Engine 對外暴露與 Claude 對齊的 `sessionId` 介面，讓上層（`src/main/agent/index.ts` 的 session manager）只看到單一抽象：

- **Lazy**：只在 first message 送出時才產生（`crypto.randomUUID()`），不在 init 階段預先建立 — 避免空 session 垃圾留盤。
- **Unify**：與 Claude 的 `providerSessionIds[provider]` 同一張表，邏輯一致。
- **/clear 後重開新 id**：舊 sessionId 對應的存檔檔案刪除，下次 first message 再開一個。

### D2. Storage Adapter 注入（不直接耦合 fs）

Engine constructor 接受 `historyStore` adapter，不直接 import `fs`。介面參考 OpenAI Agents SDK 的 `Session` protocol（見下方 Prior Art）：

```ts
interface HistoryStore {
  load(sessionId: string): Promise<EngineHistory | null>;
  save(sessionId: string, history: EngineHistory): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

interface EngineHistory {
  version: 1;
  messages: ChatCompletionMessageParam[];
  model?: string;
  effort?: string;
  createdAt: number;
  updatedAt: number;
}
```

好處：
- **Testability**：測試時可傳 in-memory adapter。
- **可換後端**：未來要換 SQLite、IndexedDB（renderer 側）、雲端都不用改 engine。
- **Main process 實作**：先做 file-based（`userData/agent-state/<sessionId>.json`）。

### D3. Per-Tab Keying（不 per-project-provider）

存檔 key 是 tab-level sessionId，而不是 `(projectId, provider)` 組合鍵。原因：

- 同一個 project 可以同時開多個同 provider 的 agent tab（每個 tab 各自一段對話）。
- Tab 關掉後 sessionId 仍保留在 `ProjectConfig.agentSessionIds`，下次同 tab 重建會 resume；tab 永久刪除時清掉對應檔。

### 次要決策

- **`/clear` 語義**：等同「開新對話」—— delete 舊檔、產生新 sessionId、清空 in-memory history。
- **存檔時機**：每個 turn 結束後 `save()`（包含 tool call round-trip 完成）。throttle 不做，因為 turn 本來就慢。
- **`/compact` 用便宜 model**（見下）。

## Architecture

```
┌─────────────────────── Renderer ───────────────────────┐
│ AgentView ──init(sessionIds)──► IPC                     │
└─────────────────────────────────────────────────────────┘
                         │
┌────────────────────── Main ────────────────────────────┐
│ agent/index.ts (session manager)                        │
│   providerSessionIds: Partial<Record<Provider, string>> │
│         │                                               │
│         ▼                                               │
│  ┌──────────────┐       ┌──────────────┐                │
│  │ Claude path  │       │ Engine path  │                │
│  │ SDK resume   │       │ load history │                │
│  │              │       │  from store  │                │
│  └──────────────┘       └──────┬───────┘                │
│                                 ▼                       │
│                         HistoryStore                    │
│                         (file-based)                    │
│                  userData/agent-state/<id>.json         │
└─────────────────────────────────────────────────────────┘
```

### 資料流

**First message（新 tab）**
1. Engine 無 sessionId → 產一個 `crypto.randomUUID()`。
2. Engine 跑 turn，結束後 `store.save(id, history)`，並透過 status event 把 sessionId 吐給 session manager。
3. Session manager 把 id 塞進 `providerSessionIds[provider]`，持久化到 `ProjectConfig.agentSessionIds`（磁碟）。

**Reload（app 重啟）**
1. Renderer 從 `ProjectConfig.agentSessionIds[provider]` 拿 id，傳給 `agent.init`。
2. Main 把 id 塞進 session；engine 啟動時若有 id 則 `store.load(id)` 還原 history。
3. 使用者看到的對話延續。

**/clear**
1. Engine 清 in-memory history、`store.delete(oldId)`、捨棄 id。
2. 下一次 first message 又走新 id 流程。

### 與 Claude 的對稱性

| | Claude (SDK) | Engine (OpenAI compat) |
|---|---|---|
| Session 來源 | SDK 發的 `session_id` | Engine `randomUUID()` |
| Resume 機制 | `query({ options: { resume: id } })` | `store.load(id) → history[]` |
| 儲存位置 | Claude SDK 內部（transcript） | `userData/agent-state/*.json` |
| /clear 語義 | 新 id | 新 id + 刪舊檔 |

Session manager 兩邊都只看到同一個 `providerSessionIds[provider]` 欄位 — 這是 D1 的核心價值。

## Companion：便宜 Model 做 /compact ✅ Done

實作時把邏輯放在 provider，而不是 engine — engine 暴露一個 `pickCompactModel?: (current: string) => string | undefined` callback，每個 provider 自己決定要不要推薦便宜 model、以及要不要在當前 model 就是便宜 model 時 short-circuit。好處是 engine 不需要知道 provider 清單（避免 `COMPACT_MODEL: Record<provider, id>` 那種反向耦合）。

實作位置：
- `src/main/agent/engine/index.ts` `EngineConfig.pickCompactModel` + `/compact` case
- `src/main/agent/providers/gemini.ts` — 非 flash 時 pick `gemini-2.5-flash`
- `src/main/agent/providers/copilot.ts` — 有在 `contextWindows` 裡才 pick `gpt-4o-mini`（確認在 quota 內才用）

注意事項（實作時已處理）：
- `/compact` 本來就沒帶 reasoning effort，不用額外處理。
- `stream: false` 原本就是。
- 回 `undefined` 代表「沿用當前 model」— provider 判斷不可用時就回 undefined，engine 不會塞假 id 上去。

## Priority（工作順序）

1. 🥇 **Tool result truncation** — 最高性價比，單次 grep 回應可能幾十 KB。可以在 engine 內截斷（例如保留前 N 行 + `…[truncated]…`），每次 tool call 都省。**獨立於本計畫，先做。** ✅ Done (`tools/executor.ts` 100KB cap)
2. 🥈 **Engine sessionId + HistoryStore**（本文件核心）✅ Done
3. 🥉 **Cheap compact model** ✅ Done
4. 🏅 **Auto-compact threshold**（deferred — 需先觀察 truncation 後的 context 成長曲線）

## Prior Art（2026/04 調研）

### OpenAI Agents SDK — `Session` protocol

官方 Python SDK（`openai-agents-python`）定義了一個標準 Session 介面，值得對齊：

```python
class Session(Protocol):
    async def get_items(limit: int | None) -> list[Item]
    async def add_items(items: list[Item]) -> None
    async def pop_item() -> Item | None
    async def clear_session() -> None
```

提供兩種內建實作：
- `SQLiteSession("user_123")` — in-memory（ephemeral）
- `SQLiteSession("user_123", "conversations.db")` — file-backed SQLite

還有 `OpenAIResponsesCompactionSession` wrapper：吃任何底層 Session，自動呼叫 Responses API 的 `responses.compact` 做壓縮 — 概念跟我們的「cheap model compact」類似，但走 server-side。

**對我們的啟示**：
- 介面用 `get/add/pop/clear` 四個動詞比我們草案的 `load/save/delete` 更細緻，但我們的 use case 是整份 history 一次 load/save（turn 結束），粗粒度反而簡單。先維持 `load/save/delete`，有需要再拆。
- Wrapper 模式（compact session wraps base session）值得學：compact 策略可以做成 decorator，不污染 base store。

### OpenAI Responses API + Conversations API（2025 推出）

OpenAI 自己在 2025 年推了兩個 state 相關的新 API：

- **Responses API** + `previous_response_id` — request-chain 式延續，每次只送新 message；server 暫存前一輪。
- **Conversations API** — durable conversation object，可跨 device / session 共享。

**為什麼我們不用**：
1. Copilot / Gemini 不走 OpenAI 家的 endpoint，根本沒這個選項。
2. 即使走 OpenAI 官方，desktop app 要 offline 友善、要能離線讀歷史，server-side state 不合適。
3. 引入 server state 會讓 provider 抽象爆開（Claude SDK 自己管、Copilot 走 previous_response_id、Gemini 手動），反而更複雜。

結論：**manual history + local persistence** 仍是對我們最合適的路線，符合 OpenAI 官方文件對 desktop app 的建議。

### Continue.dev / Aider / Cline

同類 AI coding tool 的做法調研（2026/04）：

- **Continue CLI (`cn`)** — 支援 `cn --resume`，有內建 session 管理，細節未公開但確認有 local persistence。
- **Cline** — 社群討論 #1570 指出目前 persistence 較弱，正在擴充 contextual agent 管理。
- **`cli-continues`**（第三方）— 跨工具 session 轉移，驗證了「local JSON session file」是這個生態的主流格式。

**對我們的啟示**：market 上主流就是 local file-based session store，方向正確。不需要 over-engineer 到 SQLite — 先上 JSON，需要 query / search 再升。

## Open Questions（實作前要決定）

1. **圖片附件怎麼存**？`ChatCompletionMessageParam` 的 image content 是 base64 或 URL，直接落盤會讓 JSON 膨脹。選項：
   - (a) 原樣存（簡單，檔案變大但沒副作用）
   - (b) 圖片另存 `userData/agent-state/blobs/<hash>.png`，history 內存引用（複雜，要管 GC）
   - 建議先選 (a)，觀察檔案大小。
2. **檔案格式版本化**：schema 加 `version: 1`，未來 migration 走明確 upgrade path（像 settings.json）。
3. **併發寫入**：同一 tab 理論上不會同時兩個 turn 在跑（UI 會鎖 input），但要不要加 write lock？先不加，靠 JS 單執行緒 + turn 順序保證。
4. **清理政策**：舊檔何時清？✅ 已實作：
   - `/clear` 刪當前 session 的檔（engine 側 `clearAllState()`）
   - Project 被刪除時，renderer 收集 `agentSessionIds` 所有 id 呼叫 `agent.deleteHistories()` 一次性掃掉（`deleteHistoryFiles()` in history-store.ts）
   - 沒做 app 啟動時 sweep — 選擇只在 project remove 時做，避免在啟動 hot path 再多一次 fs 掃描；正常流程下不會有孤兒檔。

## Checkpoints（實作時）

實作時分三個 commit：

1. **HistoryStore + EngineHistory schema + file adapter**（純新增，沒行為改變）
2. **Engine 接 sessionId + load/save hook**（engine/index.ts 改造、加測試）
3. **Renderer wiring + /clear 語義**（AgentView 讀 sessionIds、clear 送 delete）

每個 commit 都要有 regression test（CLAUDE.md rule）。

## Sources

- [OpenAI Agents SDK — Sessions](https://openai.github.io/openai-agents-python/sessions/)
- [OpenAI — Conversation state guide](https://developers.openai.com/api/docs/guides/conversation-state)
- [Cline — Persistent Contextual Agents discussion #1570](https://github.com/cline/cline/discussions/1570)
- [cli-continues — cross-tool session transfer](https://github.com/yigitkonur/cli-continues)
- [Continue Docs — CLI `cn --resume`](https://docs.continue.dev/guides/cli)
