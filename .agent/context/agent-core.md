---
type: context
title: Agent Core
related:
  - architecture/agent-turn
  - contracts/agent-wire-protocol
  - context/agent-providers
  - context/agent-ui
  - context/background-tasks
  - context/deployment
---

# Agent Core

> Agent tab 的核心架構：兩 provider 各自原生 SDK、tab/provider 綁定、雙層持久化、fail-loud 解析、server-owned send queue。

## agent-core#1 — Agent View：兩 provider 各自原生 SDK + bundled CLI  ·  [Decision]

**Decision**: Agent tab 直接呼叫 AI provider SDK（不是解析 terminal scrollback）：
- Claude → `@anthropic-ai/claude-agent-sdk`，spawn bundled `claude` binary
- Copilot → `@github/copilot-sdk`，spawn bundled `@github/copilot` CLI（SDK 是 JSON-RPC wrapper，CLI 才是實際執行體）

兩者都在 `agent-server` bundle 裡執行，透過 stdin/stdout JSON line protocol 跟 main process 通訊。Binary 透過 `electron-builder` 的 `files` + `asarUnpack` 打包進 app（per-platform：claude-agent-sdk-{darwin|linux|win32}-{arch}、copilot-{darwin|linux|win32}-{arch}）。**Windows build 額外 force-install `claude-agent-sdk-linux-x64`**（CI step，因為 WSL agent-server 跑在 Linux）；npm `os` 限制用 `--force --no-save` 繞過。

**Reason**:
- 之前用 terminal scrollback parsing 偵測 agent 狀態，TUI rendering 讓 stripped text 不可識別，永遠回傳 `cli_running`。直接用 SDK 拿到 structured state（idle/streaming/waiting_permission）。
- Copilot 試過 Vercel AI SDK（直打 `/chat/completions` + `/responses`）但 multi-turn 死路：Copilot 不支援 `store: true`、`previous_response_id`，replay history 又因 tool_call ID server 不認 404。Copilot CLI 本身解決了 stateful 對話，SDK 只是 wrap 它。
- 兩條路徑現在對稱：spawn bundled CLI binary、依賴使用者已有的官方 CLI 登入狀態（不經手 token）。

**Do not change casually because**:
- 不要嘗試自己對 Copilot 的 OpenAI-compatible endpoint 做 multi-turn —— 已驗證走不通。
- 不要把 binary 改成 runtime 下載 —— 第一次使用會等很久，且需要 network；bundle 進 app 是體積換體驗。

## agent-core#2 — Dual-Mode Tab State Detection  ·  [Decision]

**Decision**: Tab 狀態偵測分兩條路：Agent tab → `getAgentState()` 從 session manager 拿 structured state；Terminal tab → scrollback heuristic（既有的 `inferTabState`）。`resolveTabState()` 在 `tab-watcher.ts` 統一派發。

**Reason**: Agent tab 有 structured state（SDK 直接回報），比 scrollback parsing 準確。Terminal tab 沒有 SDK，只能用 heuristic。兩者不互斥。

**Do not change casually because**: 不要嘗試統一成單一偵測機制 —— agent tab 和 terminal tab 的資訊來源根本不同。

## agent-core#3 — Agent Tab 固定 Provider，每 Project 每 Provider 至多一個  ·  [Decision]

**Decision**: Agent tab 建立時綁定一個 provider（claude 或 copilot），不可在 tab 內切換。UI 層限制同一個 project 不能開兩個相同 provider 的 agent tab（`addTab()` 檢查 + TabBar menu disabled）。Backend 透過 tabId-based session 管理，架構上不限制數量。

**Reason**: Provider 切換涉及完全不同的 context/session 管理（Claude SDK session vs Copilot modelMessages），切換會丟前 provider 對話。固定綁定讓 sessionId 跟 provider 一對一。

**Do not change casually because**: 不要做 tab 內 provider 切換 —— context 不相容。

## agent-core#4 — Agent 雙層持久化：Server-side Context File + Client-side IndexedDB  ·  [Decision]

**Decision**: Agent 對話持久化分兩層：
- **Server-side**（`~/.shelf/agent-context/{sessionId}.json`）：Copilot 存 `modelMessages`（會被 compaction 壓縮）/ `lastResponseId` 用於 API 呼叫；Claude 存 `lastSdkSessionId` 作為 SDK `options.resume` 的指針（對話本體在 SDK 自管的 `~/.claude/projects/`），詳見 `background-tasks#1`
- **Client-side**（IndexedDB `shelf-agent-history`）：存完整 UI messages（含 user messages、tool calls 展開等），用於重新開啟 tab 時恢復顯示

SessionId 是 UUID v4，存在 `ProjectConfig.agentSessionIds[provider]`，兩層用同一個 key。

**清理策略**：
- Server-side：agent-server 啟動時掃描，移除 `updatedAt` 超過 30 天 + 損壞 JSON
- Client-side：remove project 時清對應 session，不做定期掃描（在本機且跟 project 生命週期綁定）

**Reason**: Server-side context 被 compaction 或 SDK 管理，無法恢復原始 UI。IndexedDB 在 renderer 直接可用，不需要 IPC round-trip。Context 檔在遠端機器累積無人清，30 天 cutoff 涵蓋合理 resume 需求。

**Do not change casually because**:
- 不要合併成單一 persistence —— compacted data 無法恢復原始 UI。
- 不要用 file 替代 IndexedDB —— renderer 讀寫 file 需要 IPC。
- 不要在 client 端觸發 server-side 清理 —— 要走 IPC + SSH exec，太複雜。

## agent-core#5 — Fake provider 作為 E2E 入口、fixture per-test scope  ·  [Decision]

**Decision**:
- **agent-server 內建 fake provider**（`agent-server/providers/fake.ts`），speak 同一個 `ServerBackend` interface + 同一組 `OutgoingMessage` shape —— 沒有 test-only event，凡 fake 能 emit 的事 real provider 都可能 emit
- **`SHELF_TEST_MODE=1` hijack 模式**：env 開時 `getBackend()` **不論 renderer 要哪個 provider** 都回 fake。Renderer 維持 `claude`/`copilot` 選項，但 wire 鏈走 fake。Production build 沒設 env → fake code dead branch
- **Scenario syntax**: prefix match + `|` chain（`text:hi|delay:30|tool:Read`），文件在 `fake.ts` JSDoc
- **Picker resolve 驗證走 echo**: fake 解 picker 後 emit `text` message `picker_answers:<json>` 或 `picker_answers:cancelled`，spec assert echo（避免戳 renderer 內部 state）
- **Playwright fixture per-test scope**（不是 worker scope）：每 test 新 Electron + tempdir

**Do not change casually because**:
- 不要把 fake.ts 改成跟 real provider 不同的 wire shape —— 整套保證來自「same wire 鏈、不跳層」。
- 不要回到 worker-scoped fixture —— `project-creation.spec.ts` 後半段、`app-startup.spec.ts:22 no projects on fresh start`、`notes.spec.ts:103 manual title overrides` 會立刻壞。
- 不要在 renderer 暴露 fake provider —— hijack 是底層替換，UI 保持跟 production 一樣的路徑。
- 不要改成「register fake as a third provider」—— 會逼 `AgentProvider` union 改 shared/types.ts、persistence schema、Settings UI 都動，contained boundary 失守。

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

**Problem**：streaming 時送出的訊息，舊架構排在 **client 端 queue**（`InputZone` 的 `reduceFlush` latch + isStreaming-driven drain），由 client **猜 turn 邊界**。毛病：① client 跟 server 重造同一件事（agent-server 早有 streaming-input 持久 session + sendChain 序列化，`background-tasks#3`）；② 猜邊界造成 burst-drain race，得加 latch 硬補；③ config slash（`/model`）繞過可見 queue、零回饋。

**Decision**：**草稿/輸入體驗留 client，但 queue 的「控制權（排序 + 釋放時機）」交給 agent-server**。client **eager-send 每則**（送出即發，不 hold）、帶 renderer-mint 的 `clientMsgId`（`crypto.randomUUID()`）；agent-server 用**顯式 queue**（`createSendQueue` 純工廠，取代不可內省的 `sendChain` promise-chain）序列化 turn + 每次變動 emit **完整有序快照** `{type:'queue', items:[{clientMsgId, state:'queued'|'running'}]}`（session-level、無 turnId，比照 task_event 在 turnId 檢查前路由到 `onQueue` sink）。client 純鏡像快照畫 chip。

**promote 機制走快照 `state:'running'`，不另開 turn_started**：原設計想重用 `turn_started` 帶 clientMsgId，但 dispatcher 對「已註冊的 foreground turnId」之 `turn_started` 會當 dup 丟、對「未註冊」之 `turn_started` 會開 server turn（`background-tasks#2`）→ 衝突。改由快照把「正在跑的那則」標 `running`，renderer 看到 running 就把樂觀 chip **升級成 timeline user bubble**（對齊 CLI：排隊訊息開跑就變「你的訊息」）。`reconcileQueueSnapshot`（純函式，`queue-reconcile.ts`）負責：promote（deduped，FIFO）、queued→chip、用 `confirmed` flag 區分「樂觀未確認（留）」vs「曾在 queue 又消失且沒跑（丟 —— user cancel 已先 client 移除，僅剩 respawn 丟失）」、prune promoted set。

**逐則取消 + ESC**：`cancel_queued {clientMsgId}` 從 queue 移除未跑的那則（running 不可取消）；ESC = clear 整個等待 queue + 中斷 running turn。兩者對每個被丟的 send emit **terminal idle on its turnId**，否則 main 為它註冊的 per-turn generator 永遠 hang。

**main 端 `activeTurns` 計數器**：eager-send 後 main 同時跑 N 個 sendMessage generator（agent-server 序列化，但 main 各持一個），用計數器讓 `session.state` 維持 streaming 到**最後一則** drain 完，否則第一則的 finally 會提早翻 idle、破壞 server-turn busy-skip。renderer 端 spinner / ESC 用 `busy = isStreaming || pendingSends.length>0` 蓋掉 turn 間的短暫 idle 閃爍。

**reconnect（v1 = 丟+不自動重送）**：現況斷線 = respawn（stdio pipe 是命脈），in-memory queue 一定沒；reconnect → 空快照 → reconcile 把 confirmed-but-vanished 的丟掉。不自動重送（respawn 也丟了去重記憶，跨行程無法用 clientMsgId 擋 dup）；auto-resend 列後續 hardening。

**純函式 + 單測**：`agent-server/send-queue.ts`（enqueue/pump/cancel/clear/snapshot，7 cases）、`src/renderer/queue-reconcile.ts`（promote/confirm/drop/prune，10 cases）、dispatcher queue 路由（2 cases）。刪除 `queue-flush.ts`（reduceFlush latch obsolete）+ store 舊 `queuedMessages` API。

**Related**：`background-tasks#3`（streaming-input 持久 session，序列化的根）、`background-tasks#2`（task_event session-level lane，queue 比照之）、`agent-server/{index,send-queue}.ts`、`src/main/agent/{index,remote,turn-dispatcher,types}.ts`、`src/renderer/{agentTabStore,queue-reconcile,agentTabSubscriptions}.ts`、`src/renderer/components/agent/{InputZone,MessageList}.tsx`、`src/shared/{ipc-channels,types}.ts`（`AGENT_QUEUE`/`AGENT_CANCEL_QUEUED`/`AgentQueueItem`）。

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
