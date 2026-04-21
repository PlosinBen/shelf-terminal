# PM Agent — Architecture Plan

## Overview

新增一個跨 project 的全域 PM（Project Manager）agent，作為 Shelf 的統一入口。使用者可以透過 PM 查詢各 project 狀態、遙控指揮既有 agent session、並透過 Telegram bridge 在人不在電腦前時繼續指揮。

> **狀態**：設計階段。尚未實作。

### 定位（最重要）

**人不在電腦前時，代替使用者坐在鍵盤前。**

- 代管**既有** project、分配/追蹤工作、與 project agent 溝通
- **不管理 Shelf 本身**（不改 settings、不建/刪 project、不改 keybinding）
- **不擴張版圖**（不建 project、不建 worktree、不開一般 terminal tab）
- 只在「使用者已授權並設定好」的範圍內操作

### 核心使用情境

1. **遙控指揮**：使用者透過 Telegram 下命令 → PM 轉發給 project agent → PM 彙整回覆
2. **自主代理**：Project agent 問 permission → PM 能判斷就自己批（積極型），異常才 escalate 到 Telegram
3. **狀態彙整**：「project A 最近怎樣？」→ PM 整合最近 agent message、note、tab 狀態回答

---

## Core Decisions

### D1. Model B + 只能重用（不親自執行）

PM **不親自執行任何操作**，只透過訊息指揮**既有** agent session。

- 沒有 `new_tab` / `create_project` / `write_to_tab` / Bash / Edit 等直接執行 tool
- 沒有 `ensure_agent_session`（PM 不能無中生有開 agent tab）
- Project 沒有 active agent session 時，PM 回使用者「請先去開 agent tab」

**為什麼**：
- PM 手乾淨，永遠沒有 cwd 問題
- Permission 矩陣簡化 —— 真正的 tool 執行永遠在 project agent 層，由那層的 permission 負責
- Telegram 橋接天然安全 —— PM 沒有破壞力，頂多讓 agent 收一則訊息
- 遞迴防範天然成立 —— PM tool 不 expose 給 project agent
- 完全貼合「代管、分配、追蹤」的定位

**代價**：project 沒 active agent 時，使用者得先手動開 agent tab。接受這個摩擦。

---

### D2. UI 位置：Sidebar 頂部固定 entry

PM 以獨立「project-like」entry 存在於 Sidebar 最上方，獨立 history，沿用既有 `AgentView` 元件渲染。

- 不佔 project 列表順序
- 獨立於任何 project、沒有 connection 概念
- Provider 可選（Claude / Copilot / Gemini），預設中階 model（Sonnet / Gemini Flash 之類）
- 使用者在 PM Settings 可自己切換 provider

---

### D3. Away Mode（全域主導權 toggle）

**同一時刻只有一個 agent 主導權**。由全域 Away Mode toggle 切換：

| Mode | Agent 主導權 | 使用者對 agent tab | Terminal tab | PM 能做什麼 |
|---|---|---|---|---|
| **OFF**（預設） | 使用者 | 可直接互動 | 正常使用 | 只能 L0 觀察 + 讀/寫 note，**不能 send_to_agent** |
| **ON** | PM | 只能看（read-only） | 正常使用（不受影響） | 完整 tool set，包含 send_to_agent |

**關鍵規則**：
- **重啟預設 OFF**（「你打開 Shelf 通常就是坐在電腦前」）
- **Mid-turn 切換 → 立即轉手**：切 OFF 時 pending permission 立刻交還 project tab UI；切 ON 時反之
- **Toggle 位置**：Sidebar PM entry 旁的顏色圓點（全域可見）+ Telegram 端帶狀態標記
- **Telegram 下指令但 OFF 時**：PM 不能 delegate，而是主動問 Telegram「要切到 ON 嗎？」，使用者按鈕確認 → flip
- **兩端都能 flip**：Shelf UI 跟 Telegram 都可以切，切換結果 sync 到另一端

**為什麼全域 toggle 而非 per-task 判斷**：
- 單一 state 好推理
- 符合「我要離開電腦了」的直覺動作
- 避免 per-task 主導權追蹤的 edge case
- 使用者失去 agent 主導權（只能看）但 terminal tab 不變，精準對應「離開電腦」的實際需求

---

### D4. Permission Routing

| 情況 | Agent permission 去哪 |
|---|---|
| Away Mode **OFF**（使用者主導） | 原本的 project tab UI（不變） |
| Away Mode **ON**（PM 主導） | PM |

**PM 主導下的處理策略：積極型 + 硬紅線保護**

使用者指定 PM 為**積極型**（aggressive）：現代 LLM 夠聰明，大部分操作讓它跑，**預設 bypass permission**（等同 `--dangerously-skip-permissions`），**只有兩類例外**：

1. **硬紅線 pattern**（tool layer 強制）→ 強制 escalate，PM 沒有 auto-allow 的權力
2. **「特別奇怪」的行為**（PM judgment）→ PM 主動 escalate

這樣 escalation 變 rare，Telegram 不會被 permission spam 淹沒。

**硬紅線採 prompt 層 + tool 層雙重實作**：
- **prompt 層**：在 PM system prompt 寫明「禁止自己批的類型」讓 PM 有一致認知
- **tool 層**：pattern match 程式強制，命中直接進 escalate 通道，LLM 無法繞過
- Pattern 清單放 shared module，兩處 read 同一份 source of truth

**預設硬紅線清單**（MVP 寫死）：
- `rm -rf`（特別是 root-adjacent 或 `/` 路徑）
- `git push --force` / `git push -f`
- `DROP TABLE` / `TRUNCATE`
- `chmod 777`
- 其他破壞性 SQL / 高風險系統操作

Phase 2 再開放使用者自訂 pattern。

---

### D5. Escalation UX（Telegram inline button）

PM escalate 一個 permission request 時，Telegram 訊息格式（MVP）：

```
📋 Project A — Permission needed

Agent wants to run:
`rm -rf dist/node_modules`

Your last ask: "清掉 build 產物重跑" (10 min ago)
PM note: 這個指令會刪兩個目錄，超出一般 "build clean" 範圍，想確認。

[ ✅ Allow ] [ ❌ Deny ]
```

- **帶 context**（使用者最後一次指令 + 時間）
- **帶 PM 理由**（為什麼 escalate）
- **Allow / Deny 兩顆按鈕**
- **按下後 inline edit** 成 ack（例如「✅ Allowed by you at 14:32」）

Phase 2 再加「💬 Ask more」按鈕跟「Allow session / Allow forever」粒度選項。

---

### D6. PM 對話：單一長 stream，Shelf + Telegram 合併

PM 的對話是**一條無限長的 thread**，Shelf UI 跟 Telegram 是同一條 thread 的兩個 view。

- 從 Shelf 打的訊息要 push 到 Telegram、從 Telegram 來的訊息要 sync 到 Shelf
- Message dedupe（同一則不重複顯示）
- 順序保證（處理兩端同時打字的 race）
- `/compact` 自動處理 context window（但 provider 間行為不一致，見 D10）
- **原則性 prompt 一律放 system prompt**，不放 history 前綴（因為 `/clear` 清 history 但不動 system prompt，system prompt 也不會被 `/compact` 動到）

**為什麼合併**：符合「PM 是同一個實體」的直覺，使用者在 Shelf 聊一半出門用 Telegram 繼續問，PM 有連續記憶。

---

### D7. 雙層灌輸的 Prompt 設計

為避免 LLM 被近期 user turn 帶偏離原則，採雙層 prompt：

1. **System prompt**：放原則、紅線清單、授權邊界定義、Note 維護規則 — 最可靠的 pin 位置（`/clear` 不動、`/compact` 不壓）
2. **每次 user-originated task 前綴**：wrap 一層「Reminder: 授權邊界 = [使用者最後明確指令]，超出 escalate」 — 對抗 recency bias，但會被 `/clear` 清掉，所以**只是輔助**，主力靠 system prompt

**Compact-resilient**：原則區塊放 compact 不會動到的地方（system prompt + 每 turn 前綴），確保長對話也不漂移。

**硬紅線在 tool 層強制**（非 prompt 層），避開 prompt injection 繞過。

---

### D8. Project Note 當 Long-term Memory

每個 project 有一份 markdown note，當作 PM 的跨 session 記憶體。

**儲存位置**：`~/.config/shelf/pm/notes/<projectId>.md`
- 跟 credentials 同一家（per-machine，參考 gotcha #27）
- Markdown 讓使用者 debug 時可以手動打開看「PM 腦袋在想什麼」
- 不污染 project repo

**寫入權**：只有 PM。使用者想影響 note → 請 PM 同步或改寫。實際檔案 fs 層使用者能改，但設計語意上 PM 是 sole writer；PM 下次 write 會覆蓋。

**格式：Rolling summary（受控大小的多項目摘要）**

```markdown
# Project A

**Last update**: 2025-04-20 14:32

## Active
- **Refactor module X** (started 2025-04-19)
  - agent 完成 core，測試 3 fails in tests/module-x.test.ts
  - blocked on: mock setup 需要重寫

## Recently done (keep briefly)
- Feature Y PR sent (2025-04-18)

## Open loops
- Timezone edge case in util/date.ts (discovered 2025-04-15)

## Context hints
- 使用者偏好小步 commit，不要一個 PR 塞十個檔
```

**維護規則（寫進 PM system prompt，強制執行）**：
1. **總長度硬上限 ~300 字 / 2KB**，超過必須壓縮
2. **新事件優先**；舊事件越久越壓成一句話或刪除
3. **四區段骨架**：Active / Recently done / Open loops / Context hints（不是每區都要填）
4. **Recently done 只留 1-2 條**，超過合併或丟
5. **Open loops 除非明確解決否則保留**
6. **Read-update 循環**：每次 PM 碰到某 project，必須 `read_project_note` → 做事 → `write_project_note`（覆寫整張卡）

**為什麼 Rolling summary 而非 log 或 single-snapshot**：
- 「只剩最後一條」會讓平行多任務的 context 蒸發、Open loops 被覆寫掉
- 「log 累積」會無限膨脹、token 成本爬升
- Rolling summary 由 PM 每次 write 時合併，舊的壓縮新的進來，大小受控

---

### D9. Telegram Bridge

**MVP**：手動填 bot token + chat_id 到 Settings
- Token 存 `~/.config/shelf/telegram.json`（跟 credential 模式一致）
- `allowedChatIds` 是 allowlist，必須有才接訊息
- Long polling（不用 webhook，不用對外 expose port）
- 「沒開就看不到」—— Shelf 關著時 Telegram 訊息累積在 bot API 的 offset queue，打開後一次拉回追上

**Phase 2**：Pairing code 流程（使用者不用手動找 chat_id）
- Shelf 產生一次性 code
- 使用者對 bot 說 `/pair <code>`
- Bot 驗證後加入 allowlist
- 支援多 chat pair（手機 + 桌面 Telegram Desktop）

---

### D10. Provider 間 /clear /compact 行為不一致（Known Gap）

實際現況（2026-04 時點）：

| Provider | `/clear` | `/compact` | 實作位置 |
|---|---|---|---|
| **Copilot** | ✅ | ✅ | `engine/index.ts:413,420` — engine 共用 |
| **Gemini** | ✅ | ✅ | 同上 |
| **Claude** | ❌ | ❌ | SDK 的 `supportedCommands()` 不 expose（是 Claude CLI 內部 UI 動作） |

Claude 靠 `session.sdkSessionId` 維持對話連續性，要「clear」只能 reset 該 id 讓下次 query 變新 session。`/compact` 則完全倚賴 Claude SDK 的 auto-compact，時機 / 策略黑盒。

### 對 PM agent 的含義

1. **Phase 2 實作前必須補 Claude 的 `/clear`**
   - 實作：把 `session.sdkSessionId` 清掉即可，不需要動 SDK 層
   - 可直接抄 engine 的 `/clear` pattern，engine 跟 provider 之間補一條 `resetSession()` method

2. **`/compact` 在 Claude 上目前沒辦法手動觸發**
   - MVP 接受「Claude provider 沒有手動 compact」，靠 SDK auto-compact
   - Phase 2+ 候選方案（擇一）：
     - (a) 文件說明「PM 選 Claude 時犧牲手動 compact 能力」
     - (b) 模擬：reset session + 把 summary 塞進新 session 的第一個 user turn 當 context —— 會打亂 Claude session 語意，風險高
     - (c) 追蹤 Claude SDK 後續版本是否 expose `/compact`

3. **D7 的 compact-resilient prompt 假設**
   - Copilot/Gemini 的 engine 壓 middle 留 head + tail —— 可預測
   - Claude 的 compact 是 SDK 黑盒 —— 我們不能假設 head / tail 會留
   - 所以**原則性 prompt 一律放 system prompt**（已經在 D7 調整），不要嘗試用 head N 則 history 作為 pin 位置

4. **PM 選 Claude 時的建議**
   - 因為沒 manual compact，PM 對話要更主動靠 Note 卸載長期記憶
   - 定期（或 token 接近上限時）prompt PM「把跨 turn 的重要狀態寫進相關 project 的 note，然後使用 `/clear` 開新 session」
   - 這個流程由 PM 自己判斷 + 執行，避免依賴 SDK 的 auto-compact

---

## Tool 清單

### L0 觀察（read-only，預設 auto-allow）

- `list_projects()` — 回所有 project 的基本資料
- `get_project(id)` — 單一 project 詳情
- `list_tabs(projectId)` — 該 project 的所有 tab，標記 type / agent session
- `list_agent_sessions()` — 全 Shelf 的 active agent sessions
- `get_agent_status(tabId)` — 單一 agent 的狀態（provider / model / running / last activity）
- `get_recent_messages(tabId, n)` — 摘要形式，**非原文 dump**（避免 context 爆炸）
- `read_scrollback(tabId, n)` — 讀一般 terminal tab 的最近 n 行輸出

### L0.5 Note（預設 auto-allow）

- `read_project_note(projectId)` — 讀 rolling summary
- `write_project_note(projectId, content)` — 覆寫整張卡

### L3 溝通（permission-gated；Away Mode OFF 時整組 disable）

- `send_to_agent(tabId, message)` — 對既有 agent session 送訊息
  - Away Mode OFF → tool 完全不 available
  - Away Mode ON → 可呼叫；首次對某 project send 走 permission，之後記住

**禁用 tool（永遠不 expose 給 PM）**：

- `remove_project` —— 不可逆，明確禁用
- `clear_agent_history` —— 不可逆，使用者自己在 UI 清
- `clear_uploads` —— 使用者自己在 ProjectEditPanel 清
- `update_setting` —— Shelf 自身設定，非 PM 職權
- `edit_project`（結構性欄位：cwd / connection type） —— 會讓既有 tab 狀態分裂
- `new_tab` / `close_tab` —— PM 不執行，只透過既有 agent 溝通
- `write_to_tab` —— 直接鍵入 terminal 太危險且不必要
- `connect` / `disconnect` / `kill_pty` —— 同上
- `create_project` / `create_worktree` —— 不擴張版圖（worktree 延後，待 open-worktree 重構後再議）
- `switch_project` / `switch_tab` —— 不搶 UI 焦點

---

## Visual Indicators

- **Sidebar PM entry**：旁邊一個顏色圓點
  - 🟢 綠 = Away Mode OFF（使用者主導）
  - 🔴 紅 = Away Mode ON（PM 主導）
- **Telegram**：bot 訊息帶狀態標記（例如每則訊息底部一行小字 `mode: away`），或透過 bot profile
- **全域可見原則**：模式狀態不能只躲在 PM 視圖裡

---

## MVP Phasing

### Phase 1 — PM 骨架 + 唯讀代管
- Sidebar 頂部 PM entry、獨立 history
- Main↔renderer 雙向 bridge（給 PM tool 存取 Shelf 狀態）
- L0 觀察 tool 全套 + L0.5 筆記 tool
- 無 Away Mode（永遠只讀），無 Telegram
- **驗收**：PM 能正確回答「現在哪些 project 在跑、最近有無錯誤、Note 能讀寫」

### Phase 2 — Away Mode + send_to_agent
- Away Mode toggle + 視覺指示
- `send_to_agent` tool + permission 整合
- Tool 層硬紅線 pattern match
- PM 積極型 prompt + compact-resilient reminder 機制
- **驗收**：開 Away Mode 後 PM 能完整代理使用者指揮 agent；紅線 pattern 強制 escalate

### Phase 3 — Telegram 單向
- Settings 加 bot token + chat_id 欄位
- Long polling 啟動/停止
- PM 的 assistant turn 鏡射到 Telegram
- Away Mode 狀態標記
- **驗收**：人不在電腦前能被動接收 PM 更新

### Phase 4 — Telegram 雙向 + 按鈕 permission
- Telegram user msg 轉成 PM user turn（context 合併）
- Inline button permission（Allow / Deny）
- PM 主動問「要切 Away Mode 嗎？」的 button flow
- **驗收**：完整遙控指揮迴圈，包含 escalation

### Phase 5（選配）— 體驗優化
- Pairing code（取代手填 chat_id）
- 「Allow session / Allow forever」粒度
- 使用者自訂紅線 pattern
- 紅線「Ask more」按鈕
- 多裝置同步 note（if needed）

---

## 未定/延後

- **多裝置 note 同步**：目前 per-machine，未來若要共用要走 opt-in
- **Worktree create**：待 open-worktree 機制重構後再議
- **PM 的 prompt 骨架細節**：留到實作時定
- **Telegram 長訊息格式**（agent 回傳 100 行 log 的摘要呈現）：實作時再調
- **Multi-user / 共享 PM**：超出 MVP 範圍

---

## 相關參考

- `DECISIONS.md` #1（Event bus 驅動）、#2（Connector factory）、#28（Method-per-capability）、#30（oneShotRequest）
- `GOTCHAS.md` #27（Credentials per-machine）
- `features/AGENT_SDK_INTEGRATION.md`（Agent tab、provider 架構）
