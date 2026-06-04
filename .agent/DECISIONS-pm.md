# DECISIONS — PM Agent

PM agent（背景自動駕駛、Telegram bridge、write_to_pty、project note）相關決策。

編號保持歷史穩定（缺號表示已淘汰、併入 CLAUDE.md Conventions 或併入其他 decision）。跨檔 cross-ref 用 `DECISIONS #N` 直接 grep。

---

## 23. PM Scrollback 讀取走 Main Process Ring Buffer

**決策**: pty-manager 的 `onData` callback 同步寫入 per-tab ring buffer（100KB cap），PM tools 直接從 buffer 讀取 + ANSI strip。不走 renderer IPC round-trip 取 xterm buffer。

**原因**: xterm buffer 在 renderer，main→renderer 的 invoke 需要 request-response dance。Ring buffer 在 main process 直接可用，不依賴 renderer 存活，且 memory bound（50 tabs × 100KB = 5MB）。

**不要改**: 不要改成 main→renderer IPC 取 xterm buffer — 會增加延遲、且 renderer 最小化時可能不回應。

---

## 24. PM 用 OpenAI-compatible API + `@ai-sdk/openai` 收斂多 provider

**決策**: `llm-client.ts` 透過 `@ai-sdk/openai` 的 `createOpenAI({ baseURL, apiKey })` + `ai` 套件的 `streamText()` 打 OpenAI-compatible `/v1/chat/completions`，所有 provider（OpenAI / Gemini / Ollama / 未來自建）共用同一條 code path。`PM_PROVIDERS` metadata 定義每家的 `baseURL` 預設值，user 可在 `PmProviderConfig.baseURL` 覆寫（見 #65）。

**原因**: 一次 SDK 處理 SSE streaming、tool_call args 跨 chunk 合併、reasoning_effort、abort signal 等 OpenAI-compatible 細節，不需要為每個 provider 重新對齊 wire 行為。`@ai-sdk/openai` 是 provider-agnostic，加新 OpenAI-compatible provider 只要新增 metadata entry，零新邏輯。

**不要改**:
- 不要加 `openai` SDK 或 `@anthropic-ai/sdk` dependency — `@ai-sdk/openai` 已涵蓋
- 不要繞過 `streamText` 自己用 `net.fetch` 打 SSE — 已驗證 ai-sdk 內部處理 OpenAI/Gemini/Ollama 都正常，自寫 fetch 等於重做 tool_call args 合併、abort、usage callback 等邏輯

**歷史**: 早期 PM 用 Electron `net.fetch` 直接打 + 手寫 SSE parser（無 npm dependency 路線），後期切到 `@ai-sdk/openai` 換取 tool_call streaming 跟跨 provider 行為一致性。本 entry 描述以新實作為準。

---

## 25. Away Mode 是全域 Toggle，非 Per-Task

**決策**: Away Mode 是單一 boolean toggle，OFF = 使用者控制 terminal、PM 只讀，ON = PM 可寫、terminal 顯示 read-only overlay。重啟預設 OFF。

**原因**: 單一 state 好推理、符合「我要離開電腦了」的直覺動作、避免 per-task 主導權追蹤的 edge case。

**不要改**: 不要做 per-tab 或 per-project Away Mode — 狀態爆炸。

---

## 26. write_to_pty 的三層保護

**決策**: `write_to_pty` tool 有三層保護：(1) Away Mode OFF 時整個 tool 不 expose 給 LLM，(2) idle_shell 狀態下拒絕寫入（防止 CLI crash 後寫進 raw shell），(3) 硬紅線 pattern match（rm -rf、git push --force 等）命中時拒絕並走 escalation。

**原因**: PM 送的對象應該是 CLI agent，不是 raw shell。三層保護確保即使 LLM 推理出錯也不會造成破壞。

**不要改**: 不要移除 idle_shell guard — 這是防止 CLI crash 後 PM 直接打 shell command 的最後防線。

---

## 27. PM/DevTools 共用右側 Panel + 收合欄

**決策**: PM 和 DevTools 都以右側可拖拉 panel 存在。PM 不放 Sidebar、不做全頁切換。toggle 按鈕集中渲染、各 panel 不自己 render collapsed tab。

**原因**: PM 和 terminal 需要同時可見（邊看 terminal 邊跟 PM 對話），放 Sidebar 會跟 project 列表衝突，全頁切換會失去 terminal 可見性。toggle 集中渲染視覺乾淨、方便加更多 panel。

**更新（footer 重設計後）**: toggle 不再用 App.tsx 的 `.right-tabs-collapsed`（28px 垂直欄已移除），改集中在 **BottomBar footer-right**（水平、沿用 `right-tab-btn` class，與 Projects toggle 並排）。「集中渲染、panel 不自己 render」的原則不變，只是渲染位置從 App.tsx 移到 BottomBar。詳見 `footer-redesign.md`。

**不要改**: 不要讓各 panel 自己 render collapsed tab — 由 BottomBar 統一管理（GOTCHAS #30 對應）。

---

## 39. PM 不直接執行任何操作，唯一輸出通道是 write_to_pty

**決策**: PM 沒有 Bash / Edit / Write / 直接 file system 操作 tool。所有「動作」都透過 `write_to_pty` 對 terminal tab 送資料，由跑在 terminal 裡的 CLI agent（Claude Code、Copilot CLI 等）實際執行。

**原因**:
- 真正的破壞性操作由各 CLI 自己的 permission 層把關，PM 不重複造輪子
- PM 永遠沒有 cwd / connection / sandbox 問題（不在 Shelf process 跑指令，是「打字進 terminal」）
- 遞迴防範天然成立 — CLI agent 看不到也呼叫不了 PM 的 tool
- Telegram 橋接天然安全 — PM 頂多讓 CLI 收一則 prompt
- write_to_pty 的三種語意（prompt / approve-deny / 中斷）由 PM 決定送什麼，但都是同一個 tool

**代價**:
- PM 理解 CLI 狀態靠解析 scrollback（非結構化），可能有解析誤差 — Decision #33 的 dual-mode detection 部分緩解
- Project 沒開 CLI 的 terminal tab 時 PM 無法指揮（user 需先手動開好）

**不要改**: 不要為 PM 加 Bash / Edit / Write tool — 一旦給了 PM 就有 cwd / sandbox / 權限 escalation 三個雷要踩。CLI 已經處理好的東西不要重做。

---

## 40. PM 對話是單一 thread，Shelf UI 與 Telegram 合併

**決策**: PM 的對話是一條無限長的 thread。Shelf UI 和 Telegram 是同一條 thread 的兩個 view。任一端發訊息都 push 到另一端，dedupe 確保不重複，順序保證處理 race。

**原因**:
- 符合「PM 是同一個實體」的直覺 — user 在 Shelf 聊一半出門用 Telegram 繼續問，PM 有連續記憶
- 不需要在兩端維護獨立 history 或做 sync 比對
- Compact / Clear 行為一致（兩端看到同一條 thread 被壓縮或清空）

**實作要點**:
- 原則性 prompt 一律放 system prompt（`/clear` 不動、`/compact` 不壓）
- 不放在 history 前綴 — 會被 clear 掉

**不要改**: 不要為 Telegram 拆出獨立 conversation — 會造成「我剛在 Shelf 講過」但 Telegram 端 PM 不知道的斷層。

---

## 41. PM 雙層 Prompt（System + Per-turn Reminder）

**決策**: PM 的 prompt 分兩層：
1. **System prompt**：放原則、紅線清單、授權邊界定義、Note 維護規則 — `/clear` 不動、`/compact` 不壓的可靠 pin 位置
2. **每次 user-originated task 前綴**：wrap 一層「Reminder: 授權邊界 = [user 最後明確指令]，超出 escalate」 — 對抗 recency bias

**原因**:
- 長對話容易被近期 user turn 帶偏離原則（recency bias）
- System prompt 是 LLM 看得最重的位置，但太遠會被淡化 — per-turn reminder 補強
- 硬紅線（rm -rf 等）不純靠 prompt — 在 `write_to_pty` handler 的 pattern match 強制（Decision #26）
- Compact-resilient — 原則放在 compact 不會動到的位置，確保長對話不漂移

**不要改**:
- 不要把原則放 history（會被 `/clear` 清掉）
- 不要拿掉 per-turn reminder，只靠 system prompt — 在長 history 後 system prompt 影響力會下降
- 不要把硬紅線從 code 層搬到純 prompt — 紅線是 last line of defense，prompt 不可信

---

## 42. Project Note 用 Rolling Summary 格式

**決策**: Project note (`<userData>/pm-notes/<projectId>.md`) 採固定四區段 markdown 結構，PM 每次 read-update-write 整張卡：

```markdown
# Project Name

**Last update**: <timestamp>

## Active
- 進行中的任務（含啟動時間、進度、blocker）

## Recently done (keep briefly)
- 1-2 條剛完成的事，超過合併或丟

## Open loops
- 已知但尚未解決的問題

## Context hints
- User 偏好、約定、歷史脈絡
```

**規則**（寫在 PM system prompt 強制執行）:
- 總長度硬上限 ~300 字 / 2KB
- 新事件優先，舊事件越久越壓成一句或刪除
- Recently done 只留 1-2 條
- Open loops 除非明確解決否則保留
- 每次碰到 project：`read_project_note` → 做事 → `write_project_note`（覆寫整張）

**原因**: PM 每次 write 時自己合併壓縮，大小受控但保留多任務脈絡。

**不要改**:
- 不要把 note 換成 append-only log — 會無限膨脹
- 不要拿掉 size 上限 — PM 不自我約束會無限膨脹
- 不要讓 user 直接編輯 note 當「寫 PM 指示」用 — PM 下次 write 會覆蓋。要影響 PM，請 PM 同步或改寫

---

## 65. PM provider 加 ollama + baseURL 對稱化覆寫 + 動態 model list flag

**決策**: PM 加 `ollama` provider 走 OpenAI-compatible `/v1` endpoint，沿用既有 `@ai-sdk/openai` 路徑（#24）。三個配套：

1. **`PmProviderConfig.baseURL?`**：所有 provider 都能 user 覆寫 baseURL（不只 ollama）。Renderer 寫的 baseURL 是 source of truth、metadata 提供 placeholder/預設。Provider 切換時清空覆寫（不同 provider 不同 endpoint）。
2. **`PM_PROVIDERS[].dynamicModelList?: boolean` flag**：generic 機制決定哪些 provider 走 `GET <baseURL>/models` 動態抓 model list。Renderer 用 metadata 判斷、不寫 `if (provider === 'ollama')`。當前只有 ollama 開，未來自建 vLLM / LM Studio 改 metadata 即可。
3. **`ProviderModel.contextWindow?` 改 optional**：`/v1/models` 不回 contextWindow，dynamic-discovered entry 留空。Renderer 顯示時 nullish guard，user 想 enrich 在 Models tab 加 custom entry override 同 id。

**原因**:
- Ollama 是 OpenAI-compatible drop-in，PM 既有 `streamText()` 0 行改就能跑通（spike `scripts/spike-ollama.ts` H1+H2 驗證）
- BaseURL 對稱化讓未來 self-hosted OpenAI / vLLM / LM Studio 都不用改 renderer，只動 metadata
- Dynamic model list 用 flag 開關：機制 generic（renderer 不感知 provider 名）但可 selective enable（避免對 OpenAI 動態 list 又要 filter 一堆 user 不關心的 dall-e/whisper）
- `/v1/models` 走得通就不走 `/api/tags` — 後者需從 baseURL 抽 host 拼路徑，會引入 ollama-specific 路徑邏輯

**不要改**:
- 不要為了 ollama 在 renderer 寫 `if (provider === 'ollama')` 條件分支（違反 DECISIONS-agent #43）。Provider-specific 純資訊 hint（tool_call model-dependent 警示）是 i18n-level UX exception，行為差異不可走這條路
- 不要走 `/api/tags`：要從 baseURL 抽 host 拼路徑，破壞 baseURL 設定一致性
- 不要在 Settings 加「Pull Model」UI — Shelf 不是 ollama 管理面板，user 在 terminal 跑 `ollama pull` 才符合 PRODUCT.md 第 1-2 點 + DECISIONS-pm #39（PM 唯一輸出通道是 write_to_pty 的精神延伸）
- 不要寫死 dynamic-discovered model 的 contextWindow — 該欄位由 user 在 Models tab 補 custom entry 提供

**配套 GOTCHAS**: 「Ollama: model 看似支援 tool_call、實測只吐 JSON text」— qwen2.5-coder 系列實測不走 native tool_call，PM 廢掉；qwen3:8b 實測 work。預設 model `qwen3:8b`、SettingsPanel 對 ollama 加靜態 hint。

**Related**: `.agent/features/pm-ollama-provider.md`、`scripts/spike-ollama.ts`、DECISIONS-pm #24（baseURL/ai-sdk 路徑）、#39（PM 不直接執行 — pull UI 拒絕的精神依據）、DECISIONS-agent #43（provider 對外行為一致）

---

## 66. PM 每 turn inject current focus 段落，default routing 走 focused project/tab

**決策**: PM `getSystemPrompt()` 每個 turn 動態組 `# Current Focus` 段落，從 renderer-synced state 拿當前 active project + tab，注入到 system prompt 尾端，並加 routing rule「user 沒明說時 default 用 focused，scan_all_tabs 只做 cross-project 驗證」。

**原因**:
- 消除「請幫我在 X 專案做 Y」冗長前綴 — 大多訊息是對 focused tab 的指令
- Telegram 場景效益最大（user 手機打字成本高）— "active" 仍可用「user 上次在 Shelf focus 的 tab」當合理 default
- 動態組 = active 切換馬上反映；寫死 prompt = 失去 reactiveness

**配套**:
- `tools.ts` `SyncedProject/SyncedTab` 加 `active?: boolean`
- `store.ts` `syncToMain` payload 帶 active marker
- `tools.ts` `getCurrentFocus()` helper
- 無 active 時 fall through 不 inject、PM 退回原 scan-first 行為

**不要改**:
- Routing rule 不要寫成「always use focused」— PM 失去 cross-project 能力
- 不要把 focus 段落寫進 SYSTEM_PROMPT_BASE — active 變化跟不上
- 不要在 user message 前綴 inject — focus 是 context 不是 user 訊息

**Related**: `.agent/features/pm-current-focus.md`、DECISIONS-pm #41（雙層 prompt 設計）— current focus 是 per-turn reminder 的特化形式

---

## 67. Telegram bridge 加 mode state machine、可遠端遙控 agent view（bypass PM）

**決策**: Telegram bridge 擴成兩 mode：

- `pm` mode（既有、預設）：訊息走 PM agent loop
- `agent:{tabId}` mode：訊息直接送 `agent.sendFromInternal(tabId, ...)`、agent 回覆透過 observer pattern mirror 回 Telegram、**完全 bypass PM**

User 用 slash command 切 mode：`/pm` / `/use_<alias>` / `/projects` / `/mode`。Alias 從 project name derive（移除非英數 + lower case），動態 register 進 `setMyCommands` 讓 Telegram 提供 autocomplete。

跨 process plumbing 走兩個 internal API（`src/main/agent/index.ts`）：
- `sendFromInternal(tabId, prompt)` — 同 IPC `AGENT_SEND` path、不經 renderer。會額外 emit 一則 `{type:'user', content:prompt}` 進 IPC.AGENT_MESSAGE 讓 renderer 把使用者氣泡也加進歷史（bridge 是 forwarder，不該讓 agent view 漏掉訊息）
- `registerOutputObserver(fn)` — 訂閱**所有 tab** outgoing AgentEvent 流，handler signature 為 `(tabId, event) => void`，由 caller 自己過濾。Bridge 在 boot 註冊一次（`initTelegramBridge`）永不解綁，handler 內部用 `mode === 'agent' && mode.tabId === tabId` gate 是否處理
- 配套 `stopFromInternal` / `listAgentTabs` / `getAgentProvider` 給 telegram bridge enumerate / 模式切換用

**為什麼 observer 是 global 不是 per-tab**: `dispatchEvent` 是純 transport layer，**不該知道**哪些 consumer 在乎哪個 tab、也不該知道 consumer 用什麼 buffering / 顯示策略（renderer streams chunk-by-chunk、telegram 一次 flush 整段）。Per-tab subscribe/unsubscribe 把生命週期跟 mode 切換綁在一起，造成「bridge 內部狀態的時機」跟「分派層」相互滲透。改成 global + caller 自己 filter 後，bridge 純粹是 message bus 的另一個 consumer，跟 renderer IPC 站平級。

**Bridge reply buffer 設計（`telegram-bridge-accumulator.ts`）**: Telegram API 對單則訊息一次 send 比多次 edit 成本低、Markdown 也要完整文字才能正確 parse，所以 bridge 要等 turn 結束才 flush — 這是 listener 自己的顯示策略，不是 dispatch 層的事。Accumulator 是**streaming-status agnostic**：只追蹤 `reply` 累積 + `idle` flush，**完全不看 `streaming`**（早期版本用 first-streaming 當 turn-start，但 claude 一個 turn 內 emit 多次 streaming refresh token counts，會把 buffer 清掉 → telegram 永遠收到 "turn ended with no reply" fallback）。Turn-start reset 由 caller 在 `routeMessageToAgent` 顯式做。

**原因**:
- PM 作為中介有「轉述失真 + 多一輪 LLM round-trip 延遲」兩個固有問題
- User 真實工作流：多 project 看進度走 PM、處理事情想直連 agent view
- 走 internal API 而非 IPC：Telegram bridge 在 main process、不該繞 renderer

**MVP 範圍刻意收窄**（明確不做、保留為 future enhancement）:
- ❌ Agent slash command（`/clear` `/compact` 等）的主動 forwarding 測試
- ❌ Reply keyboard 快速按鈕
- ❌ Streaming edit-in-place（agent turn 結束才送完整 reply）
- ❌ Permission inline keyboard（agent 跳 permission 時 Telegram 只通知 "Open Shelf to respond"、不互動）
- ❌ Picker request handling
- ❌ AgentMessage 9 variant 視覺對映（fold_diff / fold_code 等都 ignore，只取 `reply` text）
- ❌ Fuzzy alias match / mode indicator prefix / user-set alias

**配套**:
- `tools.ts` 加 `setSyncCallback` — telegram bridge 訂閱 project list 變化時 debounced re-register `/use_*` commands
- `telegram-mode.ts` 純函式 helpers：`deriveAlias` / `aliasOrFallback` / `resolveAlias` / `buildUseCommands` / `formatProjectsList`
- Observer 累積 `reply` text、status='idle' 時 flush 到 Telegram；permission/picker 即時送「Open Shelf to respond」notification

**不要改**:
- 不要把 Telegram bridge 內嵌進 agent-server — agent-server 是 deployable bundle、加 Telegram 客戶端污染封閉性
- 不要為 Telegram 設計獨立的 agent message stream channel — observer pattern register 到既有 dispatch、共用 wire 不另立
- 不要在 `setMyCommands` 註冊 provider-specific slash（`/clear` 等）— autocomplete 列表會炸、且每 provider 不同；agent slash 走 user 手打 → fall through 給 provider parseSlashPrefix
- 不要在 Telegram 嘗試完整還原 Shelf UI（fold_diff 不展開、picker 不互動）— Telegram 是 thin client、不是 full UI replica
- 不要把 mode 改 per-chat — MVP 假設單一 user、global mode

**Alias collision**：MVP 不處理。第一個註冊的 project 拿走 alias、第二個 silently fail（user 看 `/projects` 發現問題、改 project name 解）。

**Related**: `.agent/features/telegram-agent-bridge.md`、DECISIONS-pm #39（PM 唯一輸出通道是 write_to_pty — 本 feature 不違反、是另開 channel）、DECISIONS-pm #40（PM 對話是單一 thread、Shelf UI ↔ Telegram 兩 view — 本 feature 延伸到 agent）、DECISIONS-agent #43（provider 對外行為一致 — Telegram bridge 不對 provider 做特殊處理）、DECISIONS-agent #53（turnId envelope — observer pattern 設計考量）、DECISIONS-agent #60（AgentMessage 9 variant — MVP 只取 `reply` text）

---


## 68. PM Active = telegram listener master switch（Phase A）

**決策**: 新增明確的 PM Active 開關控制 telegram listener,取代「有 config 就 boot 啟動」的隱性行為。詳見 `.agent/features/pm-active-status.md`(含 Phase B / autopilot 移除評估)。

- **PM Active** = telegram listener on/off。需 telegram config(無則 toggle disabled)。持久化「當下狀態」到 `AppSettings.pmActive`,boot 還原。
- **Away 依賴 PM Active**:Away toggle 在 `!pmActive` 時 disabled;PM Active 轉 off 連帶關 Away(cascade)。理由:沒有 telegram 通道就不該進 autopilot。
- **搶權模型(409)**:同一 bot 最新 poller 贏、舊的收 409 → 舊的**立刻 yield(PM Active off)、不重試**。效果:開哪台搶哪台,其他台自動讓出,手動再開即搶回。**不可重試**(會 ping-pong)。
- **錯誤分類**:401/404(bad token)→停+報;409→yield;transient→5s retry。`apiCall` 吐 HTTP status 供分類。
- **啟動通知**:listener start 後發「Now controlled by <hostname>」+ project list（merge 後擴加 `/use_<alias>` 提示給有 agent tab 的 project,見 #67 mode switch）;兼 chat-id 驗證(首次 send,400→停)。
- **PmView read-only**:移除訊息 input + in-app slash(/clear→Clear History 鈕、/model→Settings、/compact 拿掉)。PM 由 tab 事件 / telegram 驅動,不需 app 內繞一層對話。app 內不再有 slash(只剩 telegram 一套,消除雙 `/` 混淆)。

**原因**: 給 PM 明確開關(取代隱性 always-on 燒 token);多機時免改 config 互搶(409 yield);read-only 對齊「人在電腦前不需繞一層」。

**不要改**:
- 不要把 telegram 改回「config-driven 自動啟動」— 現在由 PM Active 驅動。
- **不要在 409 重試** — 必須立刻 yield,否則兩 instance 無限搶。
- `SHELF_TEST_MODE=1` 時 `startTelegram` 故意 no-op(不打網路)— e2e 靠它驗 PM Active/Away,別拿掉。
- **Phase B(把監看 gate 從 away 搬到 pmActive、移除 autopilot)等 `/use-project-id` bridge 後再做** — 別提前(見 feature doc 評估)。merge 時注意:`/use_<alias>` bridge 已在 #67 落地,Phase B 評估可以重啟。
- `stopTelegram` 跟 `stopOnError` 共用 `cleanupListener()`(merge 時補的 bug fix:舊版 `stopOnError` 漏清 #67 加的 setSyncCallback / observer / mode state,409 yield 後 re-grab 會雙重訂閱)。修任一條 cleanup path 時記得另一條同步。

**Related**: `.agent/features/pm-active-status.md`(branch 原始位置)、DECISIONS-pm #25(Away Mode)、#39(PM 不直接執行)、#40(Shelf UI ↔ Telegram 兩 view)、#67(telegram bridge agent mode — Phase B unblocker)

---
