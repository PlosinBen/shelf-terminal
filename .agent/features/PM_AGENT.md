# PM Agent — Architecture Plan

## Overview

新增一個跨 project 的全域 PM（Project Manager）agent，作為 Shelf 的統一入口。使用者可以透過 PM 查詢各 project 狀態、遙控指揮各 project terminal 中跑的 CLI agent（Claude Code、Copilot CLI、Gemini CLI 等）、並透過 Telegram bridge 在人不在電腦前時繼續指揮。

> **狀態**：設計階段。尚未實作。

### 架構轉向：退場 AgentView，回歸 Terminal

**決策**：砍掉自建的 AgentView（engine / providers / tools / permission / history），所有 AI agent 互動回歸 terminal tab — 使用者直接在 terminal 裡跑各家 CLI（`claude`、GitHub Copilot CLI、`gemini` 等）。

**為什麼**：
- Context management、auto-compact、quota 控制由各家 CLI 自己處理，比我們自己串 OpenAI API 成熟且持續改善
- 省下 engine + provider + permission + history 整塊維護成本
- CLI 的 TUI 體驗已經越做越好，自建 AgentView 的差異化價值不足以 justify 維護負擔
- PM agent 的定位本來就是「代管+指揮」，透過 terminal 讀寫是最自然的通道

**影響**：
- PM 不再對接 structured agent session，而是透過 pty read/write 與 CLI 互動
- Permission 由各家 CLI 自己管，PM 在 Away Mode 下幫使用者按 approve/deny
- 不需要自建 agent bridge、provider abstraction、tool registry

### 定位（最重要）

**人不在電腦前時，代替使用者坐在鍵盤前。**

- 代管**既有** project、分配/追蹤工作、與 terminal 中的 CLI agent 溝通
- **不管理 Shelf 本身**（不改 settings、不建/刪 project、不改 keybinding）
- **不擴張版圖**（不建 project、不建 worktree、不自己開新 tab）
- 只在「使用者已授權並設定好」的範圍內操作

### 核心使用情境

1. **遙控指揮**：使用者透過 Telegram 下命令 → PM 轉成 prompt 送進 CLI agent 的 terminal → PM 讀 scrollback 彙整回覆
2. **自主代理**：CLI agent 停下來等確認 → PM 讀 scrollback 判斷 → 能批就按 approve，異常才 escalate 到 Telegram
3. **狀態彙整**：「project A 最近怎樣？」→ PM 讀 scrollback + note 回答

---

## Core Decisions

### D1. 透過 Terminal 間接指揮（不親自執行）

PM **不親自執行任何 shell command 或 file operation**，只透過 terminal tab 的 pty 讀寫與 CLI agent 溝通。

PM 對 terminal 的三種操作：

1. **送 prompt**（自然語言）— CLI agent 收到就像使用者打字
2. **送 approve/deny**（`y`/`n` 或對應按鍵）— CLI 問 permission 時代替使用者回應
3. **送中斷**（ESC / Ctrl+C）— CLI 繞圈圈太久或方向不對時截斷

這三個本質上都是 `write_to_pty(tabId, data)`，只是語意不同。

**為什麼安全**：
- PM 送的對象是 CLI agent（不是 raw shell），真正的破壞性操作由 CLI 自己的 permission 層把關
- PM 沒有 Bash / Edit / Write 等直接執行 tool，永遠沒有 cwd 問題
- Telegram 橋接天然安全 — PM 頂多讓 CLI 收一則 prompt
- 遞迴防範天然成立 — CLI agent 看不到也呼叫不了 PM 的 tool

**代價**：
- PM 理解 CLI 狀態靠解析 scrollback（非結構化），可能有解析誤差
- Project 沒開 CLI 的 terminal tab 時，PM 無法指揮（使用者需先手動開好）

---

### D2. UI 位置：Sidebar 頂部固定 entry

PM 以獨立「project-like」entry 存在於 Sidebar 最上方。

- 不佔 project 列表順序
- 獨立於任何 project、沒有 connection 概念
- PM 自己是一個 agent（需要 provider），使用者在 PM Settings 選 provider + model
- PM 的 UI 是從零寫的 `PmView.tsx`（輕量 chat，不沿用 AgentView — 舊的 event 綁定和 agent 假設太多，改造比重寫更痛）

---

### D3. Away Mode（全域主導權 toggle）

**同一時刻只有一個鍵盤主導權**。由全域 Away Mode toggle 切換：

| Mode | 鍵盤主導權 | 使用者對 terminal | PM 能做什麼 |
|---|---|---|---|
| **OFF**（預設） | 使用者 | 正常使用 | 只能 L0 觀察 + 讀/寫 note，**不能 write_to_pty** |
| **ON** | PM | 只能看（read-only） | 完整 tool set，包含 write_to_pty |

**關鍵規則**：
- **重啟預設 OFF**（「你打開 Shelf 通常就是坐在電腦前」）
- **Mid-turn 切換 → 立即轉手**：切 OFF 時 PM 停止寫入、使用者恢復控制；切 ON 時反之
- **Toggle 位置**：Sidebar PM entry 旁的顏色圓點（全域可見）+ Telegram 端帶狀態標記
- **Telegram 下指令但 OFF 時**：PM 不能 delegate，而是主動問 Telegram「要切到 ON 嗎？」，使用者按鈕確認 → flip
- **兩端都能 flip**：Shelf UI 跟 Telegram 都可以切，切換結果 sync 到另一端

**為什麼全域 toggle 而非 per-task 判斷**：
- 單一 state 好推理
- 符合「我要離開電腦了」的直覺動作
- 避免 per-task 主導權追蹤的 edge case
- 使用者在 Away Mode 下 terminal 變 read-only，精準對應「離開電腦」

---

### D4. Permission 簡化：CLI 自己管，PM 代按

舊版設計假設 PM 接管自建的 permission 路由。現在 CLI 各自管自己的 permission（Claude Code 有 `y/n` 確認，Copilot CLI 也有），PM 的角色變成：

| 情況 | CLI 的 permission prompt 誰回 |
|---|---|
| Away Mode **OFF** | 使用者自己在 terminal 按 |
| Away Mode **ON** | PM 讀 scrollback 看到 prompt → 判斷 → `write_to_pty` 送 approve/deny |

**PM 代按的策略：積極型 + 硬紅線**

- **預設 approve**：大部分操作讓 CLI 跑
- **硬紅線 → escalate**：scrollback 中出現特定 pattern 時，PM 不代按，改 escalate 到 Telegram
- **「特別奇怪」→ escalate**：PM judgment，覺得不對勁時主動問使用者

**硬紅線 pattern**（MVP 寫死，PM 在 scrollback 中偵測）：
- `rm -rf`（特別是 root-adjacent 或 `/` 路徑）
- `git push --force` / `git push -f`
- `DROP TABLE` / `TRUNCATE`
- `chmod 777`
- 其他破壞性操作

**雙重保護**：
- **prompt 層**：PM system prompt 寫明紅線清單，讓 PM 有一致認知
- **code 層**：`write_to_pty` 的 handler 在送出前 pattern match scrollback 最近 N 行，命中硬紅線時拒絕 approve 並強制走 escalate 通道

---

### D5. Escalation UX（Telegram inline button）

PM escalate 時，Telegram 訊息格式（MVP）：

```
📋 Project A — Permission needed

CLI wants to run:
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
- **原則性 prompt 一律放 system prompt**，不放 history 前綴（`/clear` 清 history 但不動 system prompt，system prompt 也不會被 `/compact` 動到）

**為什麼合併**：符合「PM 是同一個實體」的直覺，使用者在 Shelf 聊一半出門用 Telegram 繼續問，PM 有連續記憶。

---

### D7. 雙層灌輸的 Prompt 設計

為避免 LLM 被近期 user turn 帶偏離原則，採雙層 prompt：

1. **System prompt**：放原則、紅線清單、授權邊界定義、Note 維護規則 — 最可靠的 pin 位置（`/clear` 不動、`/compact` 不壓）
2. **每次 user-originated task 前綴**：wrap 一層「Reminder: 授權邊界 = [使用者最後明確指令]，超出 escalate」 — 對抗 recency bias，但會被 `/clear` 清掉，所以**只是輔助**，主力靠 system prompt

**Compact-resilient**：原則區塊放 compact 不會動到的地方（system prompt + 每 turn 前綴），確保長對話也不漂移。

**硬紅線在 code 層強制**（`write_to_pty` handler 的 pattern match），不純靠 prompt。

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

### D10. 掃描優先：PM 的全局意識循環

PM 不是「被動等使用者問」的 chatbot，而是需要**主動建立全局意識**的 manager。核心循環：

```
掃描全場 → 建立狀態圖 → 決策 → 執行 → 更新 note → 回報
```

**掃描全場的具體做法**：

1. `list_projects()` 取得所有 project
2. 對每個 project `list_tabs(projectId)` 取得所有 tab
3. 對每個 tab `read_scrollback(tabId, n)` 讀最近輸出
4. 從 scrollback 判斷每個 tab 的狀態：

| 狀態 | 判斷依據（scrollback heuristic） |
|---|---|
| **idle shell** | 最後一行是 shell prompt（`$` / `%` / `>`），沒跑 CLI agent |
| **cli running** | CLI agent 正在執行中（有持續輸出、spinner、進度條） |
| **cli waiting input** | CLI agent 停下來等使用者輸入（游標在 input area） |
| **cli waiting permission** | CLI 顯示 permission prompt（`Allow? (y/n)`、`Do you want to proceed?` 等） |
| **cli error** | CLI 輸出 error / stack trace / 非零 exit |
| **cli done** | CLI 完成任務，回到等待下一個 prompt 的狀態 |

**token 效率考量**：
- `read_scrollback` 預設只讀最後 50 行（足以判斷狀態），不是 dump 整個 buffer
- **快速掃描 vs 深入讀取**：PM 可以先用少量行數（10-20 行）快速判斷每個 tab 狀態，只對「需要關注」的 tab 再讀更多
- 掃描結果配合 note 形成 PM 的工作記憶，避免每次都重新全掃

**什麼時候觸發掃描**：
- 使用者問狀態時（「project A 怎樣了？」）
- Away Mode ON 時定期巡邏（間隔由 PM 自己判斷，建議 30-60 秒）
- 收到 Telegram 指令時（先掃再執行）

---

### D11. PM 自身的 Provider

PM 自己需要一個 LLM 來推理和決策。這是 Shelf 中**唯一**保留 API 直連的地方（project tab 全部回歸 CLI terminal）。

**選項**：
- 沿用既有 engine（Copilot / Gemini provider）— 維護成本低，已有 `/compact` `/clear`
- 或新增輕量 provider（只為 PM 服務）

**建議**：沿用既有 engine，但 PM session 是獨立的（不跟任何 project 共用）。Engine 的 tool registry 改為注入 PM 專用 tool set（不是 Bash/Edit/Write，而是 list_projects/read_scrollback/write_to_pty 等）。

**Context management**：PM 靠 engine 的 `/compact` 管理自己的對話長度，同時靠 Note 卸載長期記憶，兩者互補。

---

## Tool 清單

### L0 觀察（read-only，預設 auto-allow）

- `list_projects()` — 回所有 project 的基本資料（name, connection type, cwd）
- `get_project(id)` — 單一 project 詳情（tabs, connection, git branch）
- `list_tabs(projectId)` — 該 project 的所有 tab（標記哪些在跑 CLI agent）
- `read_scrollback(tabId, n?)` — 讀 terminal tab 的最近 n 行輸出（預設 50 行，**核心觀察手段**）
- `scan_all_tabs()` — **便利 tool**：一次遍歷所有 project 的所有 tab，每個讀最近 ~20 行，回傳結構化摘要：
  ```
  { projectId, projectName, tabId, tabName, lastLines: string[], inferredState: 'idle_shell' | 'cli_running' | 'cli_waiting_input' | 'cli_waiting_permission' | 'cli_error' | 'cli_done' }[]
  ```
  - `inferredState` 由 code 層 heuristic 預判（pattern match shell prompt、permission prompt、error pattern 等），PM 可以選擇信任或用 `read_scrollback` 深入看
  - **為什麼需要這個 tool**：PM 用 `list_projects` → `list_tabs` → 逐一 `read_scrollback` 要 N 次 tool call，浪費 turn 數和 token。scan_all_tabs 一次拿回全景，PM 再 drill down 需要關注的

### L0.5 Note（預設 auto-allow）

- `read_project_note(projectId)` — 讀 rolling summary
- `write_project_note(projectId, content)` — 覆寫整張卡

### L1 指揮（Away Mode OFF 時整組 disable）

- `write_to_pty(tabId, data)` — 對 terminal tab 的 pty 送資料
  - Away Mode OFF → tool 完全不 available
  - Away Mode ON → 可呼叫
  - **三種語意用途**（由 PM 決定送什麼）：
    1. 自然語言 prompt（給 CLI agent 下任務）
    2. approve/deny 按鍵（代替使用者回應 permission）
    3. ESC / Ctrl+C（中斷 CLI 當前工作）
  - **code 層保護**：送出前 pattern match scrollback，命中硬紅線時拒絕並走 escalate

**禁用 tool（永遠不 expose 給 PM）**：

- `remove_project` —— 不可逆，明確禁用
- `clear_uploads` —— 使用者自己在 ProjectEditPanel 清
- `update_setting` —— Shelf 自身設定，非 PM 職權
- `edit_project`（結構性欄位：cwd / connection type）—— 會讓既有 tab 狀態分裂
- `new_tab` / `close_tab` —— PM 不建也不關 tab
- `connect` / `disconnect` / `kill_pty` —— 不干涉連線生命週期
- `create_project` / `create_worktree` —— 不擴張版圖
- `switch_project` / `switch_tab` —— 不搶 UI 焦點

---

## Visual Indicators

- **Sidebar PM entry**：旁邊一個顏色圓點
  - 🟢 綠 = Away Mode OFF（使用者主導）
  - 🔴 紅 = Away Mode ON（PM 主導）
- **Away Mode ON 時 terminal tab 視覺提示**：tab bar 或 terminal 邊框加微妙的顏色提示，讓使用者知道「PM 正在控制」
- **Telegram**：bot 訊息帶狀態標記（例如每則訊息底部一行小字 `mode: away`）
- **全域可見原則**：模式狀態不能只躲在 PM 視圖裡

---

## MVP Phasing

### Pre-phase — AgentView 退場

在加 PM 之前，先把 project-level 的 AgentView 整套砍掉，讓 project tab 只剩 terminal。

**砍除範圍**：

| 類別 | 檔案 | 說明 |
|---|---|---|
| **Main: agent 整個目錄** | `src/main/agent/index.ts` | IPC handler（INIT/SEND/STOP/DESTROY 等） |
| | `src/main/agent/types.ts` | AgentBackend、AgentEvent 等 interface |
| | `src/main/agent/remote.ts` | Remote backend（stdin/stdout bridge） |
| | `src/main/agent/deploy.ts` | Agent-server deploy |
| **Main: providers** | `src/main/agent/providers/claude.ts` | Claude SDK wrapper |
| | `src/main/agent/providers/copilot.ts` | Copilot provider |
| | `src/main/agent/providers/gemini.ts` | Gemini provider |
| **Main: engine** | `src/main/agent/engine/index.ts` | Engine factory（agent loop、tool dispatch、compact 等） |
| | `src/main/agent/engine/types.ts` | OpenAIAdapter、ModelCatalog 等 |
| | `src/main/agent/engine/credential.ts` | Static credential store |
| | `src/main/agent/engine/history-store.ts` | File-based history |
| **Main: tools** | `src/main/agent/tools/registry.ts` | Tool schema + permission helpers |
| | `src/main/agent/tools/executor.ts` | Tool execution dispatch |
| **Main: auth** | `src/main/agent/auth/copilot-auth.ts` | Copilot OAuth |
| **Main: tests** | `src/main/agent/engine/*.test.ts` | Engine/credential/history tests |
| | `src/main/agent/tools/*.test.ts` | Tool registry tests |
| | `src/main/agent/auth/*.test.ts` | Copilot auth tests |
| | `src/main/agent/providers/*.test.ts` | Provider tests |
| **Agent-server** | `agent-server/` | 整個目錄 |
| **Renderer** | `src/renderer/components/AgentView.tsx` | Agent tab UI（**Phase 1 要為 PM 改造重用**） |
| | `src/renderer/components/AgentMessage.tsx` | 訊息渲染（同上，PM 要用） |
| | `src/renderer/agent-history.ts` | IndexedDB agent history |
| | `src/renderer/agent-actions.ts` | Agent submit 等 side effect |
| | `src/renderer/agent-actions.test.ts` | 對應 test |
| **Shared** | `src/shared/agent-providers.ts` | Provider 清單 |
| **Shared 修改** | `src/shared/types.ts` | 移除 agent-related type（AgentPrefs 等） |
| | `src/shared/ipc-channels.ts` | 移除 agent.* IPC channels |
| **Renderer 修改** | `src/renderer/store.ts` | 移除 agentStates、agent-related state |
| | `src/renderer/events.ts` | 移除 AGENT_* events |
| | `src/renderer/App.tsx` | 移除 agent event handlers、agent tab 渲染分支 |
| | `src/renderer/components/TabBar.tsx` | 移除 agent tab type 標記 |
| | `src/renderer/components/SettingsPanel.tsx` | 移除 agent provider 設定 |
| | `src/renderer/components/ProjectEditPanel.tsx` | 移除 agent session 相關 |
| | `src/renderer/env.d.ts` | 移除 `window.shelfApi.agent.*` 宣告 |
| **Main 修改** | `src/main/index.ts` | 移除 agent IPC handler 註冊 |
| | `src/main/preload.ts` | 移除 agent bridge |
| **npm deps** | `package.json` | 移除 `@anthropic-ai/claude-agent-sdk`、相關 platform packages |

**全部砍除，不保留**。AgentView / AgentMessage 有太多 agent-specific 的 event 綁定和假設，改造比重寫更痛。

**PM 在 Phase 1 從零建**：
- `PmView.tsx` — 輕量 chat component（訊息列表 + 輸入框 + markdown 渲染 + tool call 摘要顯示），預估 200-300 行
- `engine/credential.ts` — 獨立提出到 `src/main/credential.ts`（PM 的 provider 也需要），不跟 agent engine 綁定
- PM 的 LLM backend — 輕量版，只需要 chat completion + tool use + streaming，不需要 agent loop / permission gating / slash commands / plan-mode

**驗收**：
- `tsc --noEmit` 通過
- `vitest run` 通過（agent 相關 test 已刪）
- App 啟動正常，所有 project tab 只有 terminal，無 agent tab 選項
- 既有功能（terminal、sidebar、settings、worktree 等）不受影響

---

### Phase 1 — PM 骨架 + 唯讀觀察
- Sidebar 頂部 PM entry（獨立於 project 列表）
- `PmView.tsx` — 從零寫的輕量 chat UI（訊息列表 + 輸入框 + markdown + tool call 摘要）
- PM 的輕量 LLM backend（chat completion + tool use + streaming）
- L0 觀察 tool 全套（含 `scan_all_tabs`）+ L0.5 筆記 tool
- `read_scrollback` 實作（從 xterm buffer 讀、經 main process IPC 回傳）
- `scan_all_tabs` 實作（遍歷全部 tab + heuristic 狀態推斷）
- 無 Away Mode（永遠只讀），無 Telegram
- **驗收**：PM 能一次掃描全場，正確辨識哪些 tab 在跑 CLI agent、各自什麼狀態；Note 能讀寫

### Phase 2 — Away Mode + write_to_pty
- Away Mode toggle + 視覺指示
- `write_to_pty` tool + code 層硬紅線 pattern match
- PM 積極型 prompt：預設 approve，紅線 escalate（Phase 2 先 escalate 到 Shelf UI，Telegram 待 Phase 3）
- **驗收**：開 Away Mode 後 PM 能代替使用者送 prompt 給 CLI agent、幫按 approve、能 ESC 中斷；紅線 pattern 觸發 escalate

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
- Escalation 從 Shelf UI 延伸到 Telegram
- **驗收**：完整遙控指揮迴圈，包含 escalation

### Phase 5（選配）— 體驗優化
- Pairing code（取代手填 chat_id）
- 「Allow session / Allow forever」粒度
- 使用者自訂紅線 pattern
- 紅線「Ask more」按鈕
- 多裝置同步 note（if needed）

---

## Known Risks（Phase 2+，現在記下）

1. **write_to_pty 的「CLI 掉回 shell」問題**：PM 假設對面是 CLI agent 所以安全，但 CLI 跑完/crash 後 tab 回到 raw shell，PM 的 write_to_pty 就變成直接打 shell command。Phase 2 的 `scan_all_tabs` 狀態判斷要能擋這個 case — `idle_shell` 狀態下拒絕 write。

2. **scrollback 讀取路徑**：xterm buffer 在 renderer，PM tool 在 main process。需要決定走 main→renderer IPC 取 buffer，還是 main 端自己存一份 pty output ring buffer。後者不依賴 renderer 存活但多一份記憶體開銷。Phase 1 實作時定案。

---

## 未定/延後

- **多裝置 note 同步**：目前 per-machine，未來若要共用要走 opt-in
- **Worktree create**：待 open-worktree 機制重構後再議
- **PM 的 prompt 骨架細節**：留到實作時定
- **Telegram 長訊息格式**（scrollback 太長的摘要呈現）：實作時再調
- **Multi-user / 共享 PM**：超出 MVP 範圍
- **CLI 偵測精度**：`scan_all_tabs` 的 heuristic 可能誤判（把 vim 當 CLI agent、把安靜的 CLI 當 idle shell）。Phase 1 接受 heuristic + PM 自己看 scrollback 修正；Phase 2 考慮讓使用者標記 tab 用途或從 process name 偵測

---

## 相關參考

- `DECISIONS.md` #1（Event bus 驅動）、#2（Connector factory）
- `GOTCHAS.md` #27（Credentials per-machine）
- `PROJECT_MAP.md` Agent / Engine 區塊（退場對象）
