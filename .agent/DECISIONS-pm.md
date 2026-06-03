# DECISIONS — PM Agent

PM agent（背景自動駕駛、Telegram bridge、write_to_pty、project note）相關決策。

編號保持歷史穩定（缺號表示已淘汰、併入 CLAUDE.md Conventions 或併入其他 decision）。跨檔 cross-ref 用 `DECISIONS #N` 直接 grep。

---

## 23. PM Scrollback 讀取走 Main Process Ring Buffer

**決策**: pty-manager 的 `onData` callback 同步寫入 per-tab ring buffer（100KB cap），PM tools 直接從 buffer 讀取 + ANSI strip。不走 renderer IPC round-trip 取 xterm buffer。

**原因**: xterm buffer 在 renderer，main→renderer 的 invoke 需要 request-response dance。Ring buffer 在 main process 直接可用，不依賴 renderer 存活，且 memory bound（50 tabs × 100KB = 5MB）。

**不要改**: 不要改成 main→renderer IPC 取 xterm buffer — 會增加延遲、且 renderer 最小化時可能不回應。

---

## 24. PM 用 OpenAI-compatible API Format（無新 npm dependency）

**決策**: `llm-client.ts` 用 Electron `net.fetch` 直接打 OpenAI-compatible chat/completions endpoint + SSE streaming，不依賴任何 SDK。使用者在 PM settings 填 baseUrl + apiKey + model。

**原因**: 支援 Gemini（免費 tier）、OpenAI、Anthropic（OpenAI-compatible endpoint）等多家 provider，不需要 per-provider SDK。`net.fetch` 繞過 CORS 限制。

**不要改**: 不要加 `openai` 或 `@anthropic-ai/sdk` dependency — PM 的需求（chat + tool use + streaming）用 raw fetch 足夠。

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

---

## 43. PM Active = telegram listener master switch（Phase A）

**決策**: 新增明確的 PM Active 開關控制 telegram listener,取代「有 config 就 boot 啟動」的隱性行為。詳見 `.agent/features/pm-active-status.md`(含 Phase B / autopilot 移除評估)。

- **PM Active** = telegram listener on/off。需 telegram config(無則 toggle disabled)。持久化「當下狀態」到 `AppSettings.pmActive`,boot 還原。
- **Away 依賴 PM Active**:Away toggle 在 `!pmActive` 時 disabled;PM Active 轉 off 連帶關 Away(cascade)。理由:沒有 telegram 通道就不該進 autopilot。
- **搶權模型(409)**:同一 bot 最新 poller 贏、舊的收 409 → 舊的**立刻 yield(PM Active off)、不重試**。效果:開哪台搶哪台,其他台自動讓出,手動再開即搶回。**不可重試**(會 ping-pong)。
- **錯誤分類**:401/404(bad token)→停+報;409→yield;transient→5s retry。`apiCall` 吐 HTTP status 供分類。
- **啟動通知**:listener start 後發「Now controlled by <hostname>」+ project list;兼 chat-id 驗證(首次 send,400→停)。
- **PmView read-only**:移除訊息 input + in-app slash(/clear→Clear History 鈕、/model→Settings、/compact 拿掉)。PM 由 tab 事件 / telegram 驅動,不需 app 內繞一層對話。app 內不再有 slash(只剩 telegram 一套,消除雙 `/` 混淆)。

**原因**: 給 PM 明確開關(取代隱性 always-on 燒 token);多機時免改 config 互搶(409 yield);read-only 對齊「人在電腦前不需繞一層」。

**不要改**:
- 不要把 telegram 改回「config-driven 自動啟動」— 現在由 PM Active 驅動。
- **不要在 409 重試** — 必須立刻 yield,否則兩 instance 無限搶。
- `SHELF_TEST_MODE=1` 時 `startTelegram` 故意 no-op(不打網路)— e2e 靠它驗 PM Active/Away,別拿掉。
- **Phase B(把監看 gate 從 away 搬到 pmActive、移除 autopilot)等 `/use-project-id` bridge 後再做** — 別提前(見 feature doc 評估)。
- 不要讓 user 直接編輯 note 當「寫 PM 指示」用 — PM 下次 write 會覆蓋。要影響 PM，請 PM 同步或改寫

---

