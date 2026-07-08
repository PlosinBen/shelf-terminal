---
type: context
title: Background Tasks
related:
  - architecture/background-tasks
  - architecture/agent-turn
  - context/agent-providers
  - context/agent-ui
---

# Background Tasks

> 模型把工作丟背景跑（`run_in_background` / 自動背景化）時，背景事件走 turnId-less 的 `task_event` lane 解耦 busy-state，渲染成 BackgroundTasksPanel 卡片；claude 用 streaming-input 持久 session 對應 turn，session resume 純 server-side。

## background-tasks#1 — Claude Auto-Resume 純 Server-Side（含跨 process 持久化）  ·  [Decision]

**Decision**：Claude session resume 完全在 claude provider 處理。

- **同 process 內**：SDK 回傳的 `session_id` 存在 `lastSessionId` 變數，下次 query 自動帶入 `options.resume`。
- **跨 process（app 重啟、agent-server child restart）**：每個 turn 結束 `finally` 把 `lastSessionId` 寫入 `~/.shelf/agent-context/<sessionId>.json` 的 `lastSdkSessionId`；下次 process 啟動時 `seedSessionFromDisk(sessionId)` 把它讀回 `lastSessionId`，後續走原本路徑。

Seed 時機：`gatherCapabilities` 結尾（tab 開啟時必跑）+ `query()` 入口（防 capabilities 被 cache short-circuit）。同一 sessionId 一個 process 只 seed 一次（`seededSessions` Set）。Client 端也可透過 `QueryInput.resume` 顯式覆蓋。

**Reason**：
- Claude SDK 的 resume 機制只需要一個 session_id string，server 端自己追蹤最簡單。
- jsonl 對話本體在 SDK 自管的 `~/.claude/projects/<cwd-hash>/<id>.jsonl`，**和我們的 `agent-context/` 共處同一台機器**（agent-server 在 local connection 跑本機、SSH/Docker 跑遠端，指針和本體永遠同處），所以指針持久化才有意義。
- 一個 turn 寫一次盤（不是每 chunk）— 避免 disk thrash。
- Crash mid-turn 最差只丟掉這個 turn，下次 resume 從上一個 turn 的 session_id 開始（SDK 一條 jsonl 內就含上次 turn 的全部 history）。

**Do not change casually because**：
- 不要把 SDK session_id 暴露給 client — 增加 IPC 複雜度且沒有實際好處。
- 不要每 chunk / 每 message 寫盤 — 一個 turn 一次足夠。
- 不要把 `lastSdkSessionId` 存進 `projects.json`（project config）— 高頻寫入會 rewrite 整個 projects.json，且這是 backend implementation detail 不該污染 user-facing config。
- Docker connection 是已知限制：container 重建即丟（`~/.shelf/agent-context/` 跟 jsonl 都在 container 內），不要為此繞回 main process 存（指針在本機沒用，因為 jsonl 在 container 內）。

**Related**：`connection-health#2`（醒來 respawn + resume）、`background-tasks#3`（streaming-input 持久 session）、`agent-server/providers/claude/index.ts`。

## background-tasks#2 — task_event lane 解耦 busy-state + detached-loop  ·  [Decision]

> ⚠️ claude 的 detached-loop / foregroundDone / sendChainGate / identity-guard 機制已被 `background-tasks#3`（streaming-input 持久 session）取代。仍有效、未變的部分：`task_event` turnId-less lane、`normalizeTaskMessage` emission、server-turn 自動續寫的渲染原語（wire 對 renderer 不變）。下面「detached-loop」「identity-guard teardown」兩條只作歷史紀錄，現況讀 `background-tasks#3`。

**Problem**：模型把工作丟背景跑（Bash `run_in_background`、自動背景化）時，前景 turn 正常 idle，但 claude SDK 的 single-prompt generator **不在 `result` 結束** —— 它繼續吐背景任務訊息、且任務 settle 後**自動讓主 agent 續寫一段回覆**（Phase 0 實測：`result` 在前景結束就發，generator 到任務 settle（~29s 後）才結束）。兩個衍生 bug：(a) 後續訊息帶**已死的 turnId** → main 端 `event for unknown turn … dropping`；(b) claude 的 `query()` 等整個 generator 結束才 resolve，卡住 `sendChain` → 下一個前景 send 卡死（無限轉圈）。

**Decision**：

- **routing 與 busy-state 解耦**：背景事件走新 wire 訊息 `task_event`（`OutgoingMessage` variant，payload = `@shared/types` 的 `TaskEvent` / `NormalizedTask` 渲染原語），**不帶 turnId、不碰 status**。`wrapSendForTurn` 豁免它（比照 lifecycle）；turn-dispatcher `feed()` 在 turnId 檢查**之前**攔截 → session-level `onTaskEvent` callback → `IPC.AGENT_BACKGROUND_TASKS` → renderer `applyTaskEvent`。**絕不**用 `backgroundTaskId` 當 turn id（turn 綁了 idle/busy 語意，會破壞 non-blocking 本意）。
- **detached-loop（claude）**：把整個 consume loop 包進 detached async（`void drain().catch(releaseSendChain)`），`query()` 回傳的 Promise 在**前景 `result`**（`origin.kind !== 'task-notification'`，這是 SDK 標記自動續寫 turn 的判別器）就 resolve `sendChainGate`，解開 sendChain；loop 在背景續跑到 generator 真正結束。**🚫 不可用 `break` 接手**：`for await` 的 `break` 會呼叫 iterator `.return()` 殺掉 SDK generator（連背景任務一起殺）。
- **identity-guard teardown**：query() 提早 resolve 後，後一個 turn 可能已接管 module-level `activeQuery`/`abortController`；finally 用 `if (activeQuery === myQuery)` 才清，否則會蓋掉新 turn（正是 `sendChain` 序列化原本要防的 race）。
- **emission（純函式）**：`normalizeTaskMessage`（`helpers.ts`，可單測）把 SDK `task_started/updated/progress/notification` system 訊息 → `NormalizedTask`；index.ts 只持 `backgroundTasks`/`taskOutputFiles`/`ambientTaskIds` 三 map + 在 loop 呼叫它。**前景結束發 `snapshot`(仍 running 的 task)、之後逐則發** —— 同步 Bash 的 task 在前景 `result` 前就 done，自然被排除，**不會誤報卡片**（World A 不確定同步 Bash 是否也發 task_started，此設計對兩種都正確）。
- **read_task_output**：completed task 的完整輸出讀 remote `output_file`，**在 agent-server（遠端）端讀**（`ServerBackend.readTaskOutput` RPC，requestId 配對），main/renderer **永不**碰遠端 fs（憑證不跨界）。

**SDK 事實（Phase 0 真機確認）**：`result` 不帶 `background_tasks[]`（故 snapshot 靠累積事件、非 result）；status `killed→stopped`、`paused→running`；`task_type` `local_bash→shell`；`task_started.skip_transcript===true` = ambient task（不出卡）；自動續寫 turn 的 `result` 帶 `origin.kind:'task-notification'`。

**Do not change casually because**：
- 不要把 `task_event` 加 turnId（會被當 unknown turn 丟）。
- 不要在 detached-loop 裡 `break` 出 for-await（殺 generator）。
- 不要靠 `result.background_tasks[]` 做 snapshot（claude 不帶）。
- 不要把 `backgroundTasks` 跟 plan/TODO 的 `tasks` map（TaskCreate/TaskList → `renderPlan`）搞混 —— 不同概念、不同面板。
- 不要讓 idle 在背景階段重發（只前景發一次，沿用 `idleEmitted` dedup）。

**copilot 對齊**：copilot `query()` = `await session.sendAndWait()`，在前景 turn 邊界就 resolve → **不需要 detached-loop**（sendChain 不卡，與 claude 不同）。背景變動走 `session.on` 的 `session.background_tasks_changed`（空 payload ping）+ `system.notification`（agent/shell completed 等）→ debounced `rpc.tasks.list()` → 過濾 `executionMode==='background'` → `normalizeCopilotTask`（純函式，`copilot/helpers.ts`）→ emit `task_event` kind `snapshot`。**`currentSend` 永不 null**（line 944 設、不清）→ 任務在 turn 之間 settle 也能發；且 `task_event` turnId-exempt → 路由正確（claude 那個 unknown-turn bug 在 copilot 被這兩點自然化解）。`readTaskOutput`：shell 讀 `logPath`（遠端讀檔）、agent 回 `result`/`latestResponse`。status 映射 `idle→running`、`cancelled→stopped`。**⚠️ 未經真機驗證**：沒有 copilot session 可測，emission 從 SDK `.d.ts` 寫 + 純 mapper 單測；live 行為（event 名、`rpc.tasks.list()` 回傳 shape）待真跑一次確認。

**未做（future enhancement，低優先，trigger 未到）**：
- **server-turn 工具授權**：背景任務 settle 後 auto-resume 的 prose 若呼叫工具，會卡背景 drain（`canUseTool` 走 stale module-level send）。pre-existing 限制，低價值 + 踩 currentSend race，待真要時再正解。
- **copilot 真機 turn 驗證**：見上方「⚠️ 未經真機驗證」。

**Related**：`background-tasks#3`（取代 detached-loop；task_event/server-turn 渲染仍沿用）、`agent-providers#1`（provider 封裝）、`agent-ui#4`（事件/Store 分層）、`agent-ui#5`（渲染原語）、`agent-server/providers/claude/index.ts`（detached-loop）、`helpers.ts`（`normalizeTaskMessage`）、`agent-server/providers/fake/index.ts`（`task:`/`taskdone:` E2E scenarios）、`src/main/agent/turn-dispatcher.ts`（`onTaskEvent`）、`src/renderer/components/agent/BackgroundTasksPanel.tsx`、`src/renderer/agentTabStore.ts`（`applyTaskEvent`）。

## background-tasks#3 — Claude provider 改用 streaming-input 持久 session（取代 detached-loop）  ·  [Decision]

**Problem（症狀）**：同一對話流程，送出後**有時整輪沒回應，下一輪才正常**。根因確認（讀碼 + 真機 smoke）：`background-tasks#2` 的 detached-loop 讓 claude `query()` 在前景 `result` 就提早 resolve、解開 agent-server `sendChain`，**但該 turn 的 SDK query（`myQuery`）還活著在背景 drain**。下一個 send 進來時 claude `query()` 無 guard 直接再開**第二個 `sdkQuery`、resume 同一條 session**（`activeQuery = sdkQuery(...)`）→ 兩個 driver 並發打同一 session → 第二輪輸出被吞，直到第一輪背景 settle（=「下一輪」）。**copilot 無此 bug**（`sendAndWait` 對已持久化 session 逐 turn resolve、循序）。

**SDK 查證（`@anthropic-ai/claude-agent-sdk@0.3.159`，真機 spike）**：streaming-input 是一級公民 —— `query({prompt: AsyncIterable<SDKUserMessage>})` 一條持久 query；control methods `interrupt()`/`setModel()`/`setPermissionMode()`/`setMaxThinkingTokens()`/`stopTask()`/`close()`（僅 streaming 模式）。**result 無任何欄位指回來源 user message** → turn 對應只能靠順序。

**Decision**：一個 backend instance（= 一個 tab）持有**一條持久 streaming-input `sdkQuery`** + **單一 consumer loop**。每次 `query()` 把 prompt 當 `SDKUserMessage` push 進去、await「這個 turn 的前景 result」就 resolve（`sendChain` 不變、本來就對逐-turn-resolve 正確序列化 → **不可能再有第二個並發 query**）。

- **turn 對應（純函式 `claude/turn-router.ts`，9 單測）**：result 無 backref，靠順序 + 一個 wire 信號。turn 嚴格序列、各以 `system/init` 開、以一個 `result` 收。狀態機極簡：`init` → **有待處理 user push（`pendingPush>0`）就是前景、否則是 SDK auto-resume → server**；任何 `result` → **收掉「當前 active 的 turn」**（不靠 origin 配對 —— 同時只有一個 active turn，故 init 萬一猜錯也不會 hang，只會 cosmetic）；`task_*` → task lane（**不影響 turn 對應**）。
  - **Pitfall（counter-drift —— 為何用 pendingPush-presence 而非 counter 判 auto-resume）**：若用「`task_notification` arm 一個 counter、下個 `init` 消耗」判 auto-resume，會出事。因為**背景任務 settle 後模型不一定 auto-resume**（沒講話就沒那個 init）→ counter drift 正值 → **偷走下一個真前景 turn 的 init** → 該 turn 無 active lane → result 被 ignore → `query()` 永遠 hang（spinner 卡、`interrupt()` 無效因 SDK turn 早結束）→ 送下一則才慢慢 re-sync。**正是使用者回報的「stream 卡住、ESC 停不了、下一輪才正常」**。smoke 漏掉是因為它的背景任務每次都 auto-resume。改用 `pendingPush`-presence 判別即 drift-proof（deterministic 單測 `task_notification WITHOUT auto-resume` 守住）。
- **per-turn 狀態進 FIFO entry**：`send`/idle-deduped `turnSend`/`blockMsgIds`/`pendingCompactMsgId`/`resolve` 各 turn 自持（pending 前景 turn 在 FIFO `pendingPush` 排隊等 init）；consumer 把 active turn 收斂成**單一 `activeFrame`（`TurnFrame`）** —— foreground 與 server 共用一條 `routeContent`，差異走 frame 資料（見 `background-tasks#6`）。**`lastTurnSend` 取 RAW `send`（非 turnSend）** —— server turn / capabilities / task_event 不可被前景的 idle-dedup 吞掉（踩過：取成 turnSend 會吃掉 server idle）。
- **控制方法**：`setModel`/`setPermissionMode` → SDK control method（mid-session 即時，免 re-resume）；**effort 無 control method → close 舊 query + `resume=lastSessionId` 重建**（罕見、最 robust）；`dispose()` → `close()`。
- **ESC 最高優先**：`stop()` **先**同步 `cancelActiveTurns()`（resolve 在途 turn 的 `query()` + 發 idle + reset router）**再** best-effort `interrupt()`。**ESC 永不依賴 `interrupt()` 生效** —— interrupt 可能慢或 no-op（SDK turn 早結束、卡在路由），故必須本地強制收尾保證 UI + sendChain 立刻脫困。單測：interrupt 為 no-op 時 stop 仍 resolve query + 發剛好一個 idle。

**驗證**：純 router 9 單測 + 既有 background-tasks 整合測（mock SDK，序列改為真實 `task_notification → init → assistant → result`）+ **真機端到端 smoke**（`scripts/smoke-streaming-input.mjs` 驅動打包 agent-server + 真 claude）：跨 turn 同 session、**背景任務未 settle 時送第二則正常回覆（原始 bug 修復）**、auto-resume server turn。

**Do not change casually because**：
- 不要在 claude 再開 per-turn 新 `sdkQuery`（並發打同 session = 原始 bug）。
- `lastTurnSend` 必須是 RAW send（server idle / capabilities 不可被前景 idle-dedup 吞）。
- 對 renderer 的 wire 不變（仍走 `background-tasks#2` 的 task_event / server-turn 渲染原語）。
- copilot 不動（本來就持久 session）。

**Open (low priority)**：cosmetic race —— 使用者**正好在 auto-resume 視窗內**送新訊息時，auto-resume 的 init 會 consume 該 pending push（把 auto-resume prose 當成新訊息的回覆、新訊息的真正回覆改以 server turn 渲染），**不會 hang**、兩 turn 都正常收尾，只是視覺錯位（罕見）。**這也是為何 `query()` 的 resolve 維持 attribution-based（`pendingPush` + foreground frame 的 `resolve`）、不改成 settle-based（counter 歸 0 就 resolve）**：同一 interleave 下 settle-resolve 一樣會提早放行（auto-resume 的 result 讓 counter 歸 0），而且 attribution 也依賴同一條**未經 spike 驗證**的 SDK 排序不變量（新 push 的前景輸入先於 pending auto-resume 起跑 —— M1/M3 只涵蓋「auto-resume 時無 pending 下一則」），所以改 settle 無好處也修不了它 → 不改。真出事 ESC 砍 turn 重丟。另外，**小瑕疵（pre-existing）**：對話太短「沒東西可壓縮」時 SDK 不發 `compact_result`，卡片落到 fallback「Compaction did not complete」（誤導，其實是 no-op）—— 邊角、低價值，暫不修；持久 query 崩潰恢復（resume 重建 + 收尾在途 turn，目前 `teardownTurns` 發 idle）；`backgroundTasks()` 主動背景化（SDK 有，未接 UI）。

**stop-task**：`Query.stopTask(taskId)` 全鏈接線 —— `ServerBackend.stopTask`(claude→`session.query.stopTask`)、agent-server `stop_task` dispatch(fire-and-forget)、`AgentBackend.stopTask`→remote sendLine、IPC `AGENT_STOP_TASK`+preload、`BackgroundTasksPanel` running 任務的 ■ 鈕；`task_notification('stopped')` 走既有 task_event lane → 卡片顯示 ⊘。smoke：`scripts/smoke-stoptask.mjs`。

**`task_started` 時序**：`run_in_background:true` **穩定發 `task_started`**（`task_id` 與 tool-result「running in background with ID」相同），但它可能落在前景 idle **之後**幾 ms（routeTask 走「個別 emit」）→ **消費端要等 `task_event`、不要同步查**（同步查會看不到剛起的背景任務）。

**agent-server「缺 idle → renderer wedge」**：renderer 在 send 當下即切 streaming，故 **agent-server 任何 send 都必須以 idle 收尾**，否則 spinner + queue-flush latch 永久卡死（= 使用者回報「送圖不送字整個卡住」）。`handleSend` 的 guard 原本 image-only（空 prompt）回 `Missing prompt or cwd` 後**只 return、不發 idle**；ESC 也救不了（provider 無 active turn）。修：(1) 有 `images` 就算空 prompt 也放行進 SDK；(2) **每個早退路徑（prompt/cwd guard、getBackend 失敗、`sendChain.catch`）一律補發 idle**。屬 agent-server orchestration、非 claude-only（見 `agent-core#8`）。

**renderer ESC UX（維持現況不改）**：觸發維持**雙擊**（1.5s 內兩次，防誤觸誤殺一輪）；捕捉維持**綁輸入框焦點**（零誤觸風險）；`/compact` 期間維持 `stoppable=false` **不可中斷**（避免半壓縮壞狀態，通常幾秒）。ESC 的實質保證在 provider 端的 force-close（見上），renderer 行為不動。

**Related**：`background-tasks#2`（被取代的 detached-loop；task_event/server-turn 渲染仍沿用）、`agent-providers#1`（provider 封裝）、`agent-core#8`（agent-server send 必須以 idle 收尾）、`agent-config-flow#2`（slash command provider-internal dispatch）、`agent-server/providers/claude/{index,turn-router,turn-router.test}.ts`、`agent-server/providers/claude/background-tasks.test.ts`、`agent-server/index.ts`（handleSend idle 保證）、`scripts/{spike-streaming-input,smoke-streaming-input,smoke-image-only}.*`。

## background-tasks#4 — 背景任務卡片：單顆「刪除」走到 SDK + 等確認才隱藏 + tombstone 防 resurrection  ·  [Decision]

**Problem**：`BackgroundTasksPanel` 原本 running 任務有兩顆鈕 —— `■` 停止(`stopTask` 真的送到 SDK)、`×` 移除(純 `removeBackgroundTask`，**只清畫面、沒碰 provider/SDK**)。語意重疊又誤導：使用者以為 `×` 是「刪掉這個任務」，其實任務還在遠端跑。且 `×` 對 running 任務有 **resurrection bug**：`applyTaskEvent` 是 by-id upsert，local 移除後稍晚的 `stopped` echo / turn-boundary snapshot 會把卡片原地長回來。

**Decision**：合併成**單顆 `×` 刪除**，語意依任務狀態分流：
- **已結束**(completed/failed/stopped)：沒有東西要停 → 直接 `removeBackgroundTask`(local)。
- **running**：一定送 `stopTask` 到 SDK(`AGENT_STOP_TASK` → `ServerBackend.stopTask` → `Query.stopTask`)；卡片標 `stopping…` **保留顯示，等 SDK 回 terminal `task_event` 才自動移除**(panel 內 `stopping` set + `useEffect` 偵測該 id 變 `done` → 移除)。加 **5s fallback timeout** 防漏送(SDK notification 不保證送達，見 claude-code #20754)卡住。
  - 取捨：選「等確認才消失」而非「樂觀立即消失」—— 直接對應使用者「真的去移除」的要求，且不會出現「畫面沒了但遠端還在跑」的隱形 orphan。代價是多一個 stopping 過場 + timeout。

**resurrection 修法(store 端)**：`removeBackgroundTask` 把 id 記進 **`dismissedTaskIds` tombstone**；`applyTaskEvent` 對 tombstoned id 不再 upsert。`/clear`(session wipe)一併重置 tombstone(id 可重用時能重新出現)。這同時修掉舊 `×` 對 running 任務的 resurrection。

**為何不加「list/get all background tasks」**：claude-agent-sdk(`0.3.159`)**沒有** host 端列舉 API —— `Query` 只有 `stopTask(taskId)`，任務清單得自己從 `task_notification` 事件流累積(本 panel 即如此)。社群已提 feature request 但**官方 closed as not planned**(anthropics/claude-code #29011)。故維持事件流自組清單，不追求 pull API。

**後續(running vs done 的視覺/語意區隔)**：`×`「單顆鈕、狀態分流」的後端行為不變，但**外觀依狀態分化**，因為 background task(真的在跑的 process)與 plan/todo(唯讀 checklist，`background-tasks#2` 的 `tasks` map → PlanPanel)使用情境不同：**done** = 淡 `×`(無破壞性，直接 dismiss)；**running** = 一顆 danger「Stop」鈕 + spinner 狀態圖示(取代靜態 glyph，一眼看出「活著」)+ **兩段式確認**(第一下 arm 成「Stop?」、`STOP_ARM_REVERT_MS`=3s 內第二下才真殺)，避免誤點殺掉 live work。決策邏輯抽成純函式 `decideTaskButton(done, stopping, armed)` 可單測。

**驗證**：store tombstone 防復活 + `/clear` 重置 + `decideTaskButton` 狀態(單元，`agentTabStore.test.ts` / `BackgroundTasksPanel.test.ts`)；running 兩段式 Stop → stopTask 經 SDK → 確認後移除(E2E，`agent-background-tasks.spec.ts`，fake backend `stopTask` emit `stopped`)。

**Related**：`background-tasks#2`(task_event lane)、`background-tasks#3`(stop-task 全鏈)、`src/renderer/components/agent/BackgroundTasksPanel.tsx`、`src/renderer/agentTabStore.ts`(`dismissedTaskIds` / `applyTaskEvent` / `removeBackgroundTask`)、`agent-server/providers/fake/index.ts`(`stopTask`)。

## background-tasks#5 — 背景任務在前景 turn 內完成會被吞掉（snapshot 只挑 still-running）  ·  [Gotcha]

**Symptom**：「開 5 個 `run_in_background`，面板只剩 1 張卡」。

**逐層排除**(真機 probe `scripts/spike-bg-notify.ts` 一次開 5 個背景 bash)：
- **SDK 乾淨** —— 5 個 `task_started`、5 個**各自不同**的 `task_id`，一對一對應 `tool_use_id`，完成通知 5 個全到。**沒有 task_id reuse / collision**(網路上也查無此類報告；最接近的 #20754 是 parallel 通知漏送，且其 id 仍各異)。
- 故 collapse 必在**我們自己的對接**。

**Root cause**(`claude/index.ts`)：
1. `routeTask`：前景 turn 進行中(`activeForeground` 非空)的 task 事件**不逐一 emit**，只寫進 `backgroundTasks` Map。
2. `closeForegroundTurn`：turn 收尾只 `snapshot = backgroundTasks.filter(t => !t.done)`。
3. **致命組合**：某背景任務**在前景 result 之前就完成** → Map 裡標 `done` → 被 `!t.done` 濾掉，而它先前又沒被逐一 emit → **整張卡從未送達 renderer**。跑得快的幾個被吞，只剩最慢、仍 running 的進得了 snapshot → 看起來「5 變 1」。

**Fix**：`routeTask` 改成**即時送**(`task_event` 一到就 emit，連前景 turn 內也是)，不再累積到 turn 收尾。`task_event` 是 turnId-less、落在獨立的 BackgroundTasksPanel lane，**不會跟 turn 內容流交錯**，所以即時送是安全的；`closeForegroundTurn` 仍發一個 still-running 的 snapshot 作對帳(idempotent upsert)。這一次同時解掉兩件事：(a) turn 內完成的任務以 `done` 即時送達、不再被 running-only snapshot 濾掉(原 drop bug)；(b) 面板**隨任務 start/settle 即時更新**，不再「整輪結束才一口氣冒出所有卡」。

> **為何即時送安全(關鍵前提)**：`scripts/spike-sync-vs-bg.ts` 證實 **同步(前景、`run_in_background=false`)Bash 不發 `system/task_started`**，只有真正背景化的任務才發。所以即時送**永遠不會**幫前景 shell 呼叫冒假卡 —— `background-tasks#2` 當初「累積+只 snapshot running」正是為了防這個(當時 World A 不確定同步 Bash 會不會發 task_started)，前提既已推翻，即時送取而代之。
>
> 中間一版用 `pendingForegroundTaskEvents` 累積、turn 收尾 flush —— 已被即時送取代(更簡單、且修了 UX)。

**驗證**：`background-tasks.test.ts` —— ①5 個 task_started 同 turn → snapshot 帶 5 個 distinct(排除 collapse)；②bg1 turn 內完成 + bg2 running → renderer 收到**兩者**(bg1 completed、bg2 running)，先前紅燈、修後綠。

**附帶觀察(同類但不同路徑)**：前景 tool 結果(`processMessage → emitClaudeToolUse`)是**直接 emit、無 accumulate/suppress**，跟背景 lane 獨立。唯一耦合點是 **turn-router**：非 init/result/task 的內容訊息若在 `active===null` 時到達(init/result 被 mis-attribute，或 SDK 在 `result` 後又補發 assistant/tool 內容)，會被 `routeMessage` 判到 `lane:'ignore'` **靜默丟棄** —— 這正是「看不到 tool use result」的潛在 silent-drop 路徑。已在 `handleSdkMessage` 的 `ignore` 分支加診斷 log(`[claude] router dropped content with no active turn`，帶 `type/subtype/pendingPush/active`)，正常情況永不觸發；一旦印出即坐實線上有前景內容被丟。修不修行為待真機 log 確認後再定。

**Silent-drop 稽核(agent 管線)**：既然連踩兩個靜默 bug，掃了一遍「會吞資料卻不留痕」的點。結論：agent-server 的 `catch` 大多已 log 或 emit error(最終 best-effort 清理/關閉的空 catch 可接受)。真正缺 log 的是 routing/dispatch 的 drop-guard，已逐一補上 `console.error`/`log.info`/`console.warn`：
- `claude/index.ts` `handleSdkMessage` 的 `lane:'ignore'` —— content 訊息無 active turn 被丟。
- `claude/index.ts` `routeTask` —— task_ 無 `task_id`、或未知 task_ subtype 無法 normalize。
- `turn-dispatcher.ts` —— `parseRemoteMessage` 回 null(未知 wire type / msgType / 畸形 payload)的 turn 內容被丟。
- `agentTabSubscriptions.ts` `agent:onMessage` —— tab 未初始化、或 `buildAgentMsg` 對未知 msgType 回 null 的訊息被丟(renderer 端「content 不顯示」)。
這些正常情況永不觸發；一旦出現在 agent-server stderr / devtools console，即坐實某類 wire shape 沒被處理。 **copilot 同查**：`session.on` 的 switch 缺 `default` → 未知 SDK event type 靜默丟，補了 default 診斷。真機一跑發現 copilot 對**大量 lifecycle 事件**都 fire(`session.idle`/`assistant.turn_start|end`/`user.message`/`hook.*`/`permission.requested|completed`/`tool.execution_partial_result`…)，全是良性 no-op，但 agent-server stderr 在 main 端記成 `[ERROR]` → 變洗版假錯誤。改成 **`KNOWN_IGNORED_COPILOT_EVENTS` 明確 allow-list(知情忽略)，default 只對真正未知的新 type 警告一次**。其餘 catch 多已 log。copilot 的背景任務走全量 `snapshot` 重讀，故無 claude 那個「快任務 drop」問題。**已知 by-design 的略過**(ambient task 隱藏、server frame 不轉 `content_block_delta` 而是整段回覆)維持靜默，屬刻意行為。

**Related**：`background-tasks#2`(task_event lane / detached-loop)、`background-tasks#4`(面板單顆刪除)、`scripts/spike-bg-notify.ts`(多任務 probe)。

## background-tasks#6 — Auto-resume turn 走與 foreground 相同的內容路徑；busy/idle 用單一 active-cycle counter  ·  [Decision]

背景任務 settle 後，SDK auto-resume 讓 agent 自動續寫(一個 server turn：`init`→ 內容 →`result`，`turn_started` 開場、`startsTurn` 標第一則訊息讓 renderer 開新視覺區塊)。這個 server turn 的處理有兩個現況重點：

**① 內容走**單一** `routeContent`(吃一個 `TurnFrame`)。** foreground 與 auto-resume(server) turn 用**同一條**內容路徑;兩者差異全是 `TurnFrame` 上的**資料**、不是分岔的 code:`forwardAll`(foreground 轉每則 SDK 訊息含 live stream delta + result 的 cost;server 只轉 `assistant`/`user` + block 邊界 stream event `message_start`/`content_block_start`,**不**轉 `content_block_delta`,維持整段回覆、不逐字串流) + 一個 `kind==='foreground'` guard 包住 compact/auth/model-alias hook。tool_result 搭在 `user` 訊息上,所以 server 也吃 `user` 才收得到。turn 開場由 `openForegroundFrame`/`openServerFrame` 建對應的 frame(server 額外 mint turnId + 發 `turn_started`/`startsTurn`),收尾一律走 `closeFrame`。
- **為什麼是一條路徑(別再拆兩條)**:早期 foreground / server 各有一條近似複製的 `route*`,server 那條**只處理 `assistant`、漏了 `user`** → auto-resume turn 裡每個 tool_result 被整批丟掉(tool 卡開了永遠沒 body、且不觸發 orphan 警告,因 `emitClaudeToolResult` 根本沒被呼叫);又因 skip `stream_event` → block index 不前進 → 同 turn 的 reply/thinking msgId 全撞在一起互相覆蓋。合成單一 `routeContent` 後,新增內容處理只會加在一處,不可能再發生「一條 lane 漏一整類訊息」。**這是那個 bug 的根 —— 不要再把內容路徑按 turn 種類拆開。**

**② busy/idle 是一個 active-cycle **counter**(不是 per-turn 各自算)。** `init` 開 cycle(counter++)、`closeFrame` 排空(`counter = max(0, counter−1)`)、**counter 歸 0 才發 `idle`**;ESC/teardown 強制歸 0。
- **為什麼用 counter**:`SDKResultMessage` 沒有 per-turn id(只有 session_id/uuid/origin),無法把 result 配對回特定 turn → 只能**數 cardinality**。counter 對 serial 或重疊 turn **都正確**(single-slot 只能表達不重疊)。`max(0,…)` 的 clamp 吸收「無對應 init 的 stray result」(背景 drain 完無 auto-resume 時 SDK 補的 `origin:task-notification` result)→ 不多發 idle。
- **效果**:auto-resume 的 close **不可能清掉還活著的 foreground spinner**(counter 還 >0 就不發 idle)→ 因此 main 端**不再需要** `session.state==='streaming'` 的壓制(已移除)。result handler 發最終 cost/usage 用 `streaming`-state status(renderer `setStatus` 對 cost 是狀態無關套用),idle 翻轉交給 gated close。

**③ busy/idle 與 query()-resolve 是兩件事(別混用同一訊號)。** busy/idle 用 counter(上面②,任何 cycle 都算 busy);但 `query()` 的 resolve(放行 `sendChain` 下一則)**維持 attribution-based(foreground frame 帶 `resolve`、server frame 不帶),不可改成「counter 歸 0 就 resolve」** —— 見 `background-tasks#3` 的 Open(interleave 下 settle-resolve 會提早放行,且 attribution 也依賴同一條未驗證的 SDK 排序,改 settle 無益)。

**未做(follow-up)**:auth-failure 偵測目前**只在 foreground frame**(`kind==='foreground'` guard);auto-resume turn 中途 auth 過期不會觸發 AuthPane。獨立 latent bug,要開再開(需自己的 live 驗證)。

**驗證**：`background-tasks.test.ts` —— M1(stray result 被 clamp → 只 1 個 idle)、M3(foreground idle + server streaming/idle)、REPRO(auto-resume tool_result 收尾 + reply msgId 不撞)、cost+single-idle;**packaged app live 實測**過真正的 auto-resume server turn(tool 卡收尾、reply msgId 不撞、無 router drift)。

**Related**：`background-tasks#2`(task_event lane、`openServerFrame`/`turn_started`)、`agent-observability#2`(orphan tool card)、`agent-server/providers/claude/index.ts`(`routeContent`/`TurnFrame`/`closeFrame`/`emitIdleIfSettled`/`activeCycles`)、`architecture/agent-turn`。

## background-tasks#4 — 完成卡片 30s 自動消失（engagement 凍結、錯誤保留）  ·  [Decision]

**Decision**：`BackgroundTasksPanel` 對「乾淨完成」的 task 卡片排一個 `AUTO_REMOVE_MS`(30s) 自動 dismiss timer，避免完成卡片堆積。判別純函式 `shouldAutoRemove(task, engaged, stopping)`：只在 `done && status==='completed' && !error && !engaged && !stopping` 為真。

- **engagement 凍結**：使用者展開（`toggleExpand` open）任一卡片即把 id 記進 `engaged` ref → 倒數永久取消（即使再收合也不重啟）—— 使用者正在看，不要把它抽走。
- **錯誤保留**：`failed`/`stopped`/帶 `error` 的卡片永不自動消失，留給使用者看。
- **timer 生命週期**：effect 對每個 eligible id arm 一次 timer；一旦不再 eligible（展開/stopping）即 clear。unmount 時連同 stop/arm timer 一起清。removal 走既有 `removeBackgroundTask`（tombstone id，自動消失後同一 task_event 不會復活）。
- **視覺倒數（純 CSS）**：eligible 時卡片底部渲染 `.agent-task-countdown` 一條 bar，用 `scaleX(1)→0` keyframe 在 `AUTO_REMOVE_MS` 內收縮；**動畫時長 inline 吃同一常數**，和 JS timer 同 render 起跑天然同步。bar 純 cosmetic（移除由 JS timer 負責），engage 後 `shouldAutoRemove` 轉 false → bar 連同元素一起從 DOM 拿掉，不殘留。header 收合時整個 list 不渲染 → 看不到 bar，但卡片仍照常消失。

**為何不放 store / 不做成可設定**：純 renderer 顯示策略（哪張卡片該淡出），不涉 main / provider；timer 綁元件生命週期最單純。30s 寫死，無預先抽象成 setting 的需求。

**Related**：`background-tasks#2`(卡片來源 / removeBackgroundTask tombstone)、`src/renderer/components/agent/BackgroundTasksPanel.tsx`（`shouldAutoRemove` + auto-remove effect）。

## background-tasks#7 — Subagent 單一歸屬：訊息列（Agent 卡 + 巢狀內部步驟），不進背景面板  ·  [Decision]

**Problem**：丟一個 subagent（`Task`/`Agent` 工具）時，同一件事出現在**三個**地方 → 像重複：(1) 訊息列一張外層 `Agent` tool_use 卡；(2) 下方 background 面板也冒一張卡（SDK 為 subagent 發 `task_started`，`task_type` `local_agent`/`subagent`，`routeTask` 原本沒濾）；(3) subagent 內部**每個** tool_use（`parent_tool_use_id != null`）被平鋪灌進主訊息列（`parent_tool_use_id` 原本只在算 context% 時看，不做過濾）。

**Decision**：subagent 有**唯一的家 = 訊息列**，視為 turn 內的一次工具呼叫。
- **踢出背景面板**：面板只留真正 fire-and-forget 的工作（Bash `run_in_background`，會觸發 SDK auto-resume）。subagent 是「派下去、等結果回來再續」→ 屬線性 transcript，不屬「背景」lane。語意保持清爽：面板＝背景化；訊息列＝turn 內容。濾法比照前景 Bash —— 純函式 `isSubagentTaskStart`（`claude/helpers.ts`）+ `routeTask` 的 `subagentTaskIds` set，在 `task_started` 判掉、後續事件一併 drop。copilot 對齊：`normalizeCopilotTask` 後濾 `type==='agent'`。
- **內部步驟收進外層 Agent 卡片底下**（可展開），不平鋪在主列。主列只剩主 agent 自己的動作。
- **不選** panel-only / 兩處連結：使用者要的是 transcript 裡一張乾淨卡；面板失去 live 進度可接受，因為巢狀內部步驟就是即時進度視圖（各步驟 stream 進卡片）。

**Mechanism（wire + renderer 純衍生）**：
- wire 新增 optional `parentToolUseId`（見 `agent-wire-protocol`），只有 subagent 會發的 msgType 帶（reply + fold_*）。claude 從 SDK `parent_tool_use_id` 貫穿 `processMessage`（reply/thinking/tool_use）+ tool_result 重發（存進 inflight entry 再套回，pending→completed upsert 不掉巢狀）。
- renderer：store 的 flat message array **不變**（upsert-by-id 照舊）。巢狀是 `buildTurns` 的**純衍生** —— 帶 `parentToolUseId` 的訊息 group 到 id 相符的外層卡底下（`turn.children[cardId]`），找不到父卡則 fail-visible 落回 top-level（絕不丟）。`MessageList` 把 children 傳給 `AgentMessage`，在 `fold_code` 展開區內渲染（縮排 rail）。

**Do not change casually because**：
- 面板的判別前提：subagent(`local_agent`/`subagent`) 與前景 Bash 一樣**在 `task_started` 就分類**，之後同 id 事件全 drop —— 不要改成事後才濾。
- tool_result 重發**必須**沿用同一 `parentToolUseId`（存 inflight entry），否則完成時子卡會掉回 top-level。
- 巢狀只做 renderer 衍生，不要把 flat array 改成樹（persistence/upsert 會複雜化）。
- 不要把 subagent 當 background task 塞回面板 —— 面板語意 = fire-and-forget。

**驗證**：`isSubagentTaskStart` + `processMessage` 帶 `parentToolUseId`（`claude.test.ts`）、`normalizeCopilotTask` agent 濾除（`copilot.test.ts`）、`buildTurns` 巢狀 + orphan 落回（`agentTabStore.test.ts`）、builder 貫穿（`agent-message-builder.test.ts`）、E2E subagent 巢狀 + 面板不出卡 + 收合隱藏（`subagent-nesting.spec.ts`，fake `subagent:<label>` scenario 不發 task_event）。

**Related**：`background-tasks#2`（task_event lane / 面板來源）、`background-tasks#5`（前景 Bash 濾除同型模式）、`agent-ui#5`（渲染原語）、`agent-wire-protocol`（`parentToolUseId`）、`agent-server/providers/claude/{index,helpers}.ts`、`agent-server/providers/copilot/index.ts`、`agent-server/providers/fake/index.ts`（`subagent:` scenario）、`src/renderer/{agentTabStore,agent-message-builder}.ts`、`src/renderer/components/{AgentMessage,agent/MessageList}.tsx`。
