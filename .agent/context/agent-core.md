---
type: context
title: Agent Core
related:
  - architecture/agent-execution
  - contracts/agent-wire-protocol
  - context/agent-providers
  - context/agent-ui
  - context/background-tasks
  - context/deployment
---

# Agent Core

> Agent tab 的核心架構：provider 官方 transport、tab/provider 綁定、雙層持久化、fail-loud 解析、server-owned send queue。

## agent-core#1 — Agent View：每個 provider 使用其官方 transport + bundled CLI  ·  [Decision]

**Decision**: Agent tab 直接呼叫 AI provider SDK（不是解析 terminal scrollback）：
- Claude → `@anthropic-ai/claude-agent-sdk`，spawn bundled `claude` binary
- Copilot → spawn standalone `copilot` CLI binary + `--acp`（ACP over stdio），不再用 `@github/copilot-sdk`（cutover 後細節見 `agent-providers#9`）
- Codex → spawn pinned `codex app-server`，以 JSON-RPC 驅動 thread/turn、auth、config、MCP/skills 與 account status

兩者都在 `agent-server` bundle 裡執行，透過 stdin/stdout JSON line protocol 跟 main process 通訊。Binary 透過 `electron-builder` 的 `files` + `asarUnpack` 打包進 app（per-platform：claude-agent-sdk-{darwin|linux|win32}-{arch}、copilot-{darwin|linux|win32}-{arch}）。**Windows build 額外 force-install `claude-agent-sdk-linux-x64`**（CI step，因為 WSL agent-server 跑在 Linux）；npm `os` 限制用 `--force --no-save` 繞過。

**Reason**:
- 之前用 terminal scrollback parsing 偵測 agent 狀態，TUI rendering 讓 stripped text 不可識別，永遠回傳 `cli_running`。直接用 SDK 拿到 structured state（idle/streaming/waiting_permission）。
- Copilot 試過 Vercel AI SDK（直打 `/chat/completions` + `/responses`）但 multi-turn 死路：Copilot 不支援 `store: true`、`previous_response_id`，replay history 又因 tool_call ID server 不認 404。Copilot CLI 本身解決了 stateful 對話（現在直接走 CLI 的 ACP 協定，不經 SDK）。
- 兩條路徑現在對稱：spawn bundled CLI binary、依賴使用者已有的官方 CLI 登入狀態（不經手 token）。

**Do not change casually because**:
- 不要嘗試自己對 Copilot 的 OpenAI-compatible endpoint 做 multi-turn —— 已驗證走不通。
- 不要把 binary 改成 runtime 下載 —— 第一次使用會等很久，且需要 network；bundle 進 app 是體積換體驗。

## agent-core#2 — Dual-Mode Tab State Detection  ·  [Decision]

**Decision**: Tab 狀態偵測分兩條路：Agent tab → `getAgentState()` 從 session manager 拿 structured state；Terminal tab → scrollback heuristic（既有的 `inferTabState`）。`resolveTabState()` 在 `tab-watcher.ts` 統一派發。

**Reason**: Agent tab 有 structured state（SDK 直接回報），比 scrollback parsing 準確。Terminal tab 沒有 SDK，只能用 heuristic。兩者不互斥。

**Do not change casually because**: 不要嘗試統一成單一偵測機制 —— agent tab 和 terminal tab 的資訊來源根本不同。

## agent-core#3 — Agent View 固定 Provider，對話以穩定 session 辨識  ·  [Decision]

**Decision**: 同 Project 可有多個同 provider Agent View。每個 View 綁定固定 provider 與獨立 Shelf sessionId；runtime tabId 是一次掛載的身分。main 拒絕同一 session 同時掛載兩次，設定與 recovery 按 session 定位。新增臨時 View 使用 provider 預設；Save to Default 保留原 session 引用，重啟按 Default 還原。

**Reason**: Provider 決定串接方式，不應決定對話數量。固定 session/provider 綁定避免不同對話或不相容的原生 context 串線；設定不能再以 provider 作為唯一歸屬。

**Do not change casually because**: 不要做 tab 內 provider 切換 —— context 不相容。

## agent-core#4 — Agent 雙層持久化：Server-side Context File + Client-side IndexedDB  ·  [Decision]

**Decision**: Agent 對話持久化分兩層：
- **Server-side**（`~/.shelf/agent-context/{sessionId}.json`）：保存 provider resume pointer與 orchestration context；Claude/Copilot/Codex 的對話本體仍由各自 CLI/runtime管理，詳見 `background-tasks#1`
- **Client-side**（IndexedDB `shelf-agent-history`）：存完整 UI messages（含 user messages、tool calls 展開等），用於重新開啟 tab 時恢復顯示

新 sessionId 由 main 配發 UUID，舊資料沿用原 key，缺省遷移 key 具決定性。
canonical `Project.agentViews[sessionId]` 保存 provider／prefs；兩層持久化沿用同一個 key。

Client dirty snapshots 在寫入確認前獨立於 throttle 與 UI cap 保留，失敗不能遺失可重試批次。
正常退出保存已收到的對話快照後才 shutdown；生成中的 reply／thinking 保存中斷標記，
不先結束 runtime execution。取消退出仍可繼續使用原 View，詳見 keybindings-shell#7。
退出寫入也納入 teardown settlement，保存前回查 canonical owner；explicit clear 撤回舊
dirty snapshots，失敗的 clear 在後續保存或退出前先重試，再確認新訊息寫入，避免重存已
丟棄內容或稍後清掉已確認、卻已被 UI cap 移除的新訊息。

**清理策略**：
- Server-side：不按閒置天數掃描刪除 context；明確 clear 仍可刪除。讀取損壞檔案留錯誤紀錄，不由全域掃描刪除其他 session 的資料。
- Client-side：Default 或 live runtime 引用的 session 保留；兩者皆無時，等待 teardown／history writers 完成後清 history，成功再移除 canonical record。啟動回收中斷流程遺留的未引用 record；Project 刪除前將 session 歸屬寫入 IndexedDB 清理待辦，失敗／退出後仍可重試。不掃未知歸屬 history，詳見 projects#14。

**Reason**: Server-side context 被 compaction 或 SDK 管理，無法恢復原始 UI。IndexedDB 在 renderer 直接可用。target-wide context 目錄沒有完整 ownership 清單，單純過期掃描可能清掉仍在 Default 的恢復指標；因此保守保留，包括臨時 View context，不引入額外 GC。

**Do not change casually because**:
- 不要合併成單一 persistence —— compacted data 無法恢復原始 UI。
- 不要用 file 替代 IndexedDB —— renderer 讀寫 file 需要 IPC。
- 不要在 client 端觸發 server-side 清理 —— 要走 IPC + SSH exec，太複雜。

## agent-core#5 — Fake provider 作為 E2E 入口、fixture per-test scope  ·  [Decision]

**Decision**:
- **agent-server 內建 registered internal `fake` provider**，speak 同一個 `ServerBackend` interface + 同一組 `OutgoingMessage` shape —— 沒有 test-only event，凡 fake 能 emit 的事 real provider 都可能 emit
- **顯式 fake 模式**：dev/E2E renderer 可顯示並選取 `fake`，整條 state、routing、backend 與 wire identity 都維持 `fake`；production 只以 registry visibility 隱藏，不把它視為非法 provider
- **`SHELF_TEST_MODE=1` substitution 模式**：不論 requested provider 是哪個 key，都以 fake implementation 執行，但 backend registry 仍按 requested provider 分開 cache，事件與狀態保留 requested identity
- **Copilot usage transport fixture**：同時設定 `SHELF_TEST_COPILOT_USAGE=1` 時，Copilot 改走實際 provider + mock ACP agent；其他 provider 維持 fake。此 fixture 不查真實 account quota，用於證明 usage 在 provider 被攔下且正常回覆仍到 renderer，避免 fake backend 繞過被測邊界。沒有 `SHELF_TEST_MODE=1` 時不啟用。
- **Scenario syntax**: prefix match + `|` chain（`text:hi|delay:30|tool:Read`），文件在 `fake.ts` JSDoc
- **Picker resolve 驗證走 echo**: fake 解 picker 後 emit `text` message `picker_answers:<json>` 或 `picker_answers:cancelled`，spec assert echo（避免戳 renderer 內部 state）
- **Playwright fixture per-test scope**（不是 worker scope）：每 test 新 Electron + tempdir

**Do not change casually because**:
- 不要把 fake.ts 改成跟 real provider 不同的 wire shape —— 整套保證來自「same wire 鏈、不跳層」。
- 不要回到 worker-scoped fixture —— `project-creation.spec.ts` 後半段、`app-startup.spec.ts:22 no projects on fresh start`、`notes.spec.ts:103 manual title overrides` 會立刻壞。
- 不要對 fake 加 test-only validity/dispatch 分支；它和其他 provider 一樣由 registry 與 exhaustive factory 定義。
- 不要讓 substitution 模式把 requested provider key 改成 `fake` 或共用單一 backend cache —— 那會掩蓋 provider state isolation 問題。

**Related**：`agent-providers#36`。

## agent-core#6 — Provider 格式解析失敗一定要 fail-loud（serverLog('error')）  ·  [Decision]

> 通則見 CLAUDE.md「禁止靜默吞錯 / 丟資料」；本條是 **provider wire-format 解析**的具體化（preview 字數、pure parser 不 log 等）。log 機制見 `agent-core#9`。

**Decision**：任何 provider 端的 wire-format 解析（SDK tool_result content、apply_patch 字串、自訂協議 payload）失敗時，**必須在 caller 端 `serverLog('error', tag, …)` 記錄 content preview**（前 200~300 字）。不要靜默 return null/fallback。

**適用範圍**：
- `parseTaskCreateOutput` / `parseTaskListOutput`（Claude 0.3.142+ Task 系統）
- `parseApplyPatch`（Copilot apply_patch）
- 任何未來新增的 SDK-output 解析 helper

**Reason**：SDK 版本升級時 type def 跟 runtime 不一致很常見（已踩過 TaskCreate 是 text 不是 JSON、AskUserQuestion is_error 透傳變化）。沒有 log 時：
- Plan panel 莫名空白
- diff 卡突然變 raw 字串
- 用戶 / dev 都不知道原因，debug 從零開始

有 log 時：升版後第一次踩到立刻看到 `[provider] X parse failed; format may have changed { contentPreview: '...' }`，5 分鐘修。

**設計細節**：
1. **Pure parser 自己不 log**（保持可組合、可測），return null
2. **Caller 在「已知該成功的路徑」上 log** —— 例如註冊過 tool_use_id 的 tool_result 才 log，避免對任意 result 都嘗試 parse + log（noise）
3. **預期 silent path 例外** —— 例如 `parseApplyPatch` 對 Delete File 回 null 是設計如此，caller 用 marker 偵測排除這條再 log
4. **走 `serverLog('error')` → wire `log` → main `@shared/logger`**（`agent-core#9`），不送到 renderer（不是 user-facing error，renderer 已收到 fallback 形式）

**反例**（不要做）：
- 在 pure parser 內部 `serverLog` —— parser 應該可組合測試，log 是 caller 的責任
- 把 silent fallback 改成 throw —— provider 不該因 wire 格式變化整個 turn 失敗
- 在 renderer 端 log —— 訊號到那邊已經晚了，且 wire 已經把 fallback 形式送過去

**Related**：
- Claude SDK 0.3.x TaskCreate text 格式 / AskUserQuestion is_error 透傳的相關 gotcha
- `agent-server/providers/claude.ts:parseTaskCreateOutput / parseTaskListOutput` 範例
- `agent-server/providers/copilot.ts:parseApplyPatch` caller 範例

## agent-core#7 — 訊息送出佇列改 server-owned：client 樂觀顯示、agent-server 控時序  ·  [Decision]

**Problem**：streaming 時送出的訊息，舊架構排在 **client 端 queue**（`InputZone` 的 `reduceFlush` latch + isExecutionActive-driven drain），由 client **猜 execution 邊界**。毛病：① client 跟 server 重造同一件事（agent-server 早有 streaming-input 持久 session + sendChain 序列化，`background-tasks#3`）；② 猜邊界造成 burst-drain race，得加 latch 硬補；③ config slash（`/model`）繞過可見 queue、零回饋。

**Decision**：**草稿/輸入體驗留 client，但 queue 的「控制權（排序 + 釋放時機）」交給 agent-server**。client **eager-send 每則**（送出即發，不 hold），共通 Sender 將 factory 的 `msgId` 映射為 `clientMsgId`；agent-server 用**顯式 queue**（`createSendQueue` 純工廠）序列化 executions + 每次變動 emit **完整有序快照** `{type:'queue', items:[{clientMsgId, state:'queued'|'running'}]}`（session-level、無 executionId，比照 task_event 在 executionId 檢查前路由到 `onQueue` sink）。main 先接收確認，再依 Caller projection 策略轉交 renderer 鏡像快照畫 chip。

**promote 機制走快照 `state:'running'`，不另開 execution_started**：原設計想重用 `execution_started` 帶 clientMsgId，但 dispatcher 對「已註冊的 foreground executionId」之 `execution_started` 會當 dup 丟、對「未註冊」之 `execution_started` 會開 provider-initiated execution（`background-tasks#2`）→ 衝突。改由快照把「正在跑的那則」標 `running`，renderer 看到 running 就把樂觀 chip **升級成 timeline user bubble**（對齊 CLI：排隊訊息開跑就變「你的訊息」）。`reconcileQueueSnapshot`（純函式，`queue-reconcile.ts`）負責：promote（deduped，FIFO）、queued→chip、用 `confirmed` flag 區分「樂觀未確認（留）」vs「曾在 queue 又消失且沒跑（丟 —— user cancel 已先 client 移除，僅剩 respawn 丟失）」、prune promoted set。

**逐則取消 + ESC**：逐則取消以 requestId RPC 等待 queue 確認移除，renderer 保留取消中的內容；running 不可當作 queued 取消，照常 promotion／history（`agent-core#14`）。ESC = clear 整個等待 queue + 中斷 running execution。兩者對每個被丟的 send emit **terminal idle on its executionId**，否則 main 為它註冊的 execution reader 永遠 hang。

**main 端 `activeExecutions` 計數器**：eager-send 後 main 同時跑 N 個 executeMessage readers（agent-server 序列化，但 main 各持一個），用計數器讓 `session.state` 維持 streaming 到**最後一則** drain 完，否則第一則的 finally 會提早翻 idle。renderer 端 spinner / ESC 用 `busy = isExecutionActive || pendingSends.length>0` 蓋掉 executions 間的短暫 idle 閃爍。

**reconnect（v1 = 丟+不自動重送）**：現況斷線 = respawn（stdio pipe 是命脈），in-memory queue 一定沒；reconnect → 空快照 → reconcile 把 confirmed-but-vanished 的丟掉。不自動重送（respawn 也丟了去重記憶，跨行程無法用 clientMsgId 擋 dup）；auto-resend 列後續 hardening。

**純函式 + 單測**：`agent-server/send-queue.ts`（enqueue/pump/cancel/clear/snapshot，7 cases）、`src/renderer/queue-reconcile.ts`（promote/confirm/drop/prune，10 cases）、dispatcher queue 路由（2 cases）。刪除 `queue-flush.ts`（reduceFlush latch obsolete）+ store 舊 `queuedMessages` API。

**Related**：`background-tasks#3`（streaming-input 持久 session，序列化的根）、`background-tasks#2`（task_event session-level lane，queue 比照之）、`agent-server/{index,send-queue}.ts`、`src/main/agent/{index,remote,execution-dispatcher,types}.ts`、`src/renderer/{agentTabStore,queue-reconcile,agentTabSubscriptions}.ts`、`src/renderer/components/agent/{InputZone,MessageList}.tsx`、`src/shared/{ipc-channels,types}.ts`（`AGENT_QUEUE`/`AGENT_CANCEL_QUEUED`/`AgentQueueItem`）。

## agent-core#8 — agent-server 每個 send 都必須以 idle 收尾，否則 renderer 整個卡死  ·  [Gotcha]

**Symptom**: 送圖片但沒打字（空 prompt）→ 整個對話卡住、spinner 一直轉、連 ESC 都停不了。

**Root cause**: renderer 在送出當下就把 tab 翻成 streaming（等 idle 才解除）。agent-server `handleSend` 的早退路徑（prompt/cwd guard、`getBackend` 失敗、`sendChain.catch`）若只 emit `error` 就 `return`、**沒發 idle** → renderer 永遠等不到 idle → spinner + queue-flush latch 永久 wedge。ESC 也救不了 —— 此時 provider 根本沒有 active turn，`stop()` 的 interrupt / cancelActiveTurns 都是 no-op。

**Fix**: image-only 放行（有 `images` 就算空 prompt 也進 SDK）；**每個 `handleSend` 早退 / catch 一律補發 `{type:'status', state:'idle'}`**。見 `background-tasks#3`。

**Do not change casually because**: 別在任何 turn 終止路徑（含純錯誤回報）省略 idle —— 看似「只是回報錯誤」，實際會把 renderer 永久卡死。新增任何 early-return 都要記得收尾 idle。

## agent-core#9 — agent-server 無獨立 observability：log 一律回 main  ·  [Decision]

> 訊息格式見 `contracts/agent-wire-protocol`（`log`）。

**Problem**：agent-server 用不了 `@shared/logger`（它經 electron `app.getPath` 寫檔，agent-server 沒 electron），而它的 **stdout 是 wire protocol 專用**（`console.log/info` 走 stdout 會污染協定）→ 過去只能 `console.warn/error` 走 **stderr**，main `remote.ts` 把 stderr **無差別記成 `log.error`** → 良性診斷被壓平成 ERROR（例:每個正確過濾的前景 Bash 一行 `[ERROR]`，洗版）。且 **remote agent-server 的 stderr/本機檔根本拿不到** → 沒有統一可讀的 log。

**Decision**：
- **agent-server 沒有獨立 observability。除了「自己死掉」,所有 log 都回 main。** `serverLog(level, tag, msg, ...args)`（`agent-server/server-logger.ts`）→ wire `{type:'log'}` → `remote.ts` 路由到 `@shared/logger`。args 在**來源**就 flatten 成文字（`Error` 物件原樣保留 stack;過 wire JSON 會變 `{}`）。
- **level 過濾在 main**（單一真相源,`@shared/logger` 預設 `error`）：agent-server 全部送、main 決定印不印。良性 per-event 診斷用 `serverLog('debug')` → 預設自動靜音（前景 Bash drop、copilot DIAG tool 追蹤等）。
- **stderr 只剩 fatal**：sink 未接的 boot 早期 fallback、Node 預設 uncaught dump、idle-shutdown self-exit（pre-`process.exit`,wire 送不出去）。main 把 stderr 記 `error` **維持不變**——routine log 移走後它變稀有且有意義。
- `@shared/logger` 為此補了 `warn` level（`info`→`error` 語意跨度太大);順手修了 `write()` 的 case bug（caller 傳 `'ERROR'` 卻判小寫 → error 之前其實寫 stdout）。

**Do not change casually because**：
- 別在 agent-server 用 `console.log/info`（污染 stdout=wire）;診斷一律 `serverLog`。
- 別把 routine 診斷留在 stderr——會被 main 當 ERROR 且 remote 拿不到。
- 良性 per-event 用 `debug`,別用 `error/warn`（warn 在預設 level 也被濾,但語意要對）。

**Related**：`agent-core#6`（parse 失敗 fail-loud 走這條）、`contracts/agent-wire-protocol`（`log`）、`agent-server/server-logger.ts`、`src/main/agent/remote.ts`、`src/shared/logger.ts`。

## agent-core#10 — per-execution idle 是 control 管線，不可原封當 session status 轉發給 renderer  ·  [Gotcha]

**Symptom**：running execution 還在跑時，刪掉一則排隊訊息（queued chip），spinner 立刻消失、tab 看起來 idle —— 使用者只是動了待送清單，卻干擾到現在進行中的狀態。

**Root cause**：每則 send（含還沒跑的排隊則）在送出當下就被 main 綁了 `executionId` + execution reader。取消排隊時 agent-server 為了**收掉那條 reader** 會在該 executionId 上 emit 一個裸 `idle`。這個 idle 是 execution control 管線用途，不是 session 層級信號；若 renderer 把所有 execution idle 塌縮成單一 tab-wide flag，「收掉一條排隊 reader」就會被誤讀成「整個 tab idle」。

**Fix**：session 的 busy/idle 由 main 的 `activeExecutions` 獨佔（`agent-core#7`）。`executeMessage` 攔截 `status` event，**只對 terminal(`idle`/`done`) 剝掉 `state`、其餘照原樣轉發**：
- `state==='idle'`：轉發 metrics 但剝 `state`（不讓被取消的排隊 turn 之 idle 翻動 tab streaming flag）；session-level idle **只**在 `finally` 裡 `activeExecutions` 歸零時發（post-decrement → 對「多個 idle 同批抵達」race-safe，dispatch 當下用 `activeExecutions>1` 判斷不可靠：兩個 idle 可能在任一 finally decrement 前都先 dispatch）。
- `state==='streaming'`：**原封轉發**。provider 會把**turn 中途的 usage/quota 掛在 `state:'streaming'` 事件上**（copilot：`rateLimits`/`contextUsage`/token 數，`copilot/index.ts` assistant.usage / session.usage_info）。**若把 streaming status 一起吞掉，status bar 的 quota/context 會整個消失**（曾經的迴歸）。重設 streaming 對 renderer 是冪等。

observers（telegram bridge）仍收原始 per-execution idle（維持逐 execution flush 語意）。

**Do not change casually because**：別把 per-execution `status` event 直接轉回 renderer（會重蹈 idle 翻 tab 的 bug）；但也**別反向把 streaming status 一起濾掉**（會吞掉 mid-execution quota）。要剝的**只有 terminal idle 的 `state` 欄位**，metrics 與 streaming status 一律留。renderer 是 session 層級狀態的純消費者；execution reader 是 main↔agent-server 內部帳。provider-initiated execution（auto-resume）路徑是另一條且不進 `activeExecutions`，別把兩條路徑的 status 處理混為一談。

**Related**：`agent-core#7`（server-owned queue + `activeExecutions`）、`agent-core#8`（每個 send 必須以 idle 收尾）、`architecture/agent-execution`（executionId stays internal 邊界）、`src/main/agent/index.ts`（`executeMessage`/`dispatchEvent`）、`agent-server/providers/copilot/index.ts`（mid-execution usage on streaming status）、`src/renderer/agentTabSubscriptions.ts`、`e2e/agent-flows.spec.ts`（cancelling a queued send leaves the running execution streaming／mid-execution streaming usage 到 status bar）。

## agent-core#11 — Dispatcher 生命週期：thin-by-construction、崩潰要逐出、close/reopen 同-sid race 的三道 identity guard  ·  [Gotcha]

> 適用於 dispatcher 路徑（`architecture/agent-dispatch`），現為預設。舊 per-session 直連 path（`spawnAgentServer`/`wrapProcess`）以 flag 保留為**過渡 fallback**（移除已列管）。

**Thin-by-construction：dispatcher 絕不可 static-import provider / SDK 模組**。entrypoint 先 branch role（`--role=dispatcher` vs `--role=exec`，同一份 deployed bundle），provider 模組（`./providers/*`、Copilot/Claude SDK）**只在 exec role 內用 dynamic `import()` 載入**。dispatcher role 因此永遠不 load 重 SDK → 啟動快、runtime footprint / crash surface 小。static-import 會 eager 載入即使從不執行 → 所以這裡 lazy import 是**必要**、非優化。

**崩潰的 dispatcher 必須從 per-host map 逐出**：dispatcher proc exit 後，死掉的 `DispatcherConnection` 若賴在 `remote.ts` 的 `dispatchers` map（原本只有 grace-teardown 路徑刪它）→ 下個 `ensureDispatcher` 會「重用屍體」→ `openSession` 寫進已關的 stdin → `getCapabilities` 30s timeout /「Failed to start agent-server」，而非「首次 reconnect spawn 全新」。**Fix**：對稱的 `onDown` callback（在 `proc.onExit` handler 內、與 `onEmpty` 並列）逐出該 entry（guard 在仍是 current conn 才刪）。dispatcher death **不自動復原** —— 退回既有 host-disconnect 狀態，使用者 Retry 才 spawn 全新（見 `connection-health#8`）。

**Close/reopen 同-sid race + 三道 identity guard**（最尖銳的一個）：sid 是 **per-project 持久**（同 project 永遠復用同一 sid），所以一個 tab 在**舊 session teardown 尚未 fire 前**就 re-init，會撞在同一 sid 上：(a) main 的 `channels: Map<sid,…>` 被覆寫 → 孤兒舊 channel 稍後的 `kill()` 刪掉了**新** channel 的 entry 並送 `close_session`，殺掉了 reopened tab 依賴的 exec；(b) dispatcher 把重複的 `open_session` 當「already-open」丟掉 → 重啟的 tab 永遠 ready 不了。Net：reopened tab → 死 exec →「Failed to start agent-server」。**Fix = 三道 identity guard**：
1. **main `openSession` 對已開的 sid：先關舊 channel 再開新的**（replace → dispatcher 收到乾淨的 close→open）；
2. **main `kill` identity-guarded**（孤兒 channel 的 kill 變 no-op，不誤刪 current entry）；
3. **dispatcher `handleExecDown` proc-identity guard**（舊 exec 在 replace 後遲來的 exit 被忽略，不誤讀成 current exec 掛掉 → 不會亂觸發 reconnect）。

**Do not change casually because**：
- 別讓 dispatcher static-import provider/SDK —— 破壞 thin-by-construction（啟動變慢、crash surface 變大）。
- 別漏 dispatcher 崩潰的逐出 —— 賴著的屍體會讓下次連線寫進死 stdin、假性 timeout 而非乾淨重生。
- 別拿掉任一道 identity guard —— per-project 持久 sid 的 close/reopen race 會回來，孤兒 channel 誤殺新 exec。

**Related**：`connection-health#7`（reconnect：`handleExecDown` 的 fail-loud ordering）、`connection-health#8`（dispatcher death = host disconnect + Retry）、`architecture/agent-dispatch`（role-split、two-map hosting）、`src/main/agent/{remote,dispatcher-connection}.ts`、`agent-server/{index,dispatcher,exec}.ts`。

## agent-core#12 — 委派關係獨立於執行與成果提取  ·  [Decision]

**Decision:** Shelf 的 worktree Agent 委派是 main-owned、記憶體內的雙端 View 關係。
使用者透過 MCP 發起的選擇器授權指定雙端；main 可在關係內反覆送工作，spike
明確提交最新進度與單份文字結果。結果只由使用者提取，提取不解鎖。介入時拒絕
main 新工作；停止／明確關閉 View 才斷開關係，不因此停止另一端 Agent。

**Reason:** Spike 驗證常是 A → 主對話判斷 → B，單一 turn／結果不等於整段合作
結束。自動將結果送入 main 會干擾現有工作；只按 View 路由晚到回報則可能誤掛
新委派，因此穩定 View 身分與每次合作的 delegationId 必須分開。

**Do not change casually because:** transport sid／nonce 不是通用持久 View 身分。
來源必須從可信 channel 綁回 main live View，不能信任 tool args。委派提交回覆
依既有 queue snapshot，不等待 execution completion；internal ids 要與 renderer
optimistic projection 分流。接收不明時保留結果、不自動重送。雛形不保存委派
歷史或重啟恢復，原有 View／對話持久化不變。具體工具與 lifecycle 見
`contracts/agent-delegation`。

## agent-core#13 — 提交確認與執行完成分離，Caller 負責錯誤處理  ·  [Decision]

**Decision:** 所有訊息 Caller 使用共通 Sender。Sender 驗證、查目標、啟動 runner，
依 exec queue snapshot 的 queued 或 running 回傳成功，不等 provider 執行結束。
失敗回可序列化的具型別錯誤，由 Caller 處理呈現及情境狀態；D1 adapter 保留既有
delivery／結果槽契約。Runner 持續管理事件、權限、busy 計數與 finally 清理。

**Reason:** 發送操作與 Agent 工作是不同生命週期。將 runner 的完成 Promise 當
發送結果會讓內部工具等待整段工作，也迫使需要提前回覆的 Caller 另闢執行入口。
僅本地寫出還不代表 exec 接收，必須以 queue 的權威確認作為成功邊界。

**Do not change casually because:** timeout／unconfirmed 是提交操作錯誤，但可能已
送達；不得自動重送、取消 execution 或誤刪可能已接受的輸入。晚到確認獨立對帳，
不改寫已回傳的錯誤。追蹤直到 execution 結束或 View 關閉；queued 取消仍需結束
其 reader。一般輸入保留 optimistic projection，內部 mirror 必須從 renderer
projection 分流，不能把所有被 receipt 追蹤的 id 都濾除。回覆內容屬 session lane，
idle 不代表完整回覆。configEdit 暫保留自己的 completion 路徑，不偽裝為訊息 receipt。

## agent-core#14 — 取消排隊訊息以遠端結果為準，意圖不能丟掉內容  ·  [Decision]

**Decision:** 逐則取消由遠端 queue 回覆 cancelled／running／not_found。本地只標記
cancelling，保留內容並避免重複送出；只有 confirmed cancelled 才移除 chip。
若先收到 running snapshot，保留的內容照常 promotion、upsert 與持久化。缺席
snapshot 可先於取消回覆到達，取消等待期間不得因缺席而丟棄內容。

**Reason:** renderer 先刪 optimistic chip、再送取消會與 server promotion 競態。
server 已 running 時取消無效，而 snapshot 僅有 ID／state，若唯一內容已被本地刪除，
就只剩 anomaly，已執行輸入無法顯示或寫入 history。遠端才是 queue 的資料權威，
本地意圖不能冒充操作成功；無需為此導入完整 message snapshots 或重寫 history。

**Do not change casually because:** 取消失敗／無法確認須明確呈現，保留仍有的輸入，
不能默認取消成功或自動重試。running 不是停止執行的授權。RPC 使用 requestId，
另核對 clientMsgId 與 status；逾時／寫入失敗撤銷 response handler。一般非取消
狀態的 confirmed-vanished 仍要留資料遺失告警，不可為壓掉正常取消 log 一律吞掉。
此契約只涵蓋逐則 queued 取消，不改 bulk stop／ESC 的既有政策。
