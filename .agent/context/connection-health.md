---
type: context
title: Connection Health
related:
  - architecture/connection-lifecycle
  - context/deployment
  - context/skills
---

# Connection Health

> app↔agent-server 的 ping/pong heartbeat —— 連線健康 UX、cleanup lease、dead 偵測；以及「連線判 dead 後要不要動手」的存活策略。

## connection-health#1 — ping/pong heartbeat：健康 UX + cleanup lease + dead 偵測  ·  [Decision]

**Decision**：app↔agent-server 的 `ping`（帶 `seq`）/`pong`（echo `seq`）一拍**三用**：
1. **連線健康 UX**：client **單邊時鐘**算 RTT → `ConnectionHealthTracker` 5 狀態 → Sidebar project `status-dot` 5 色 + 惡化 flash。健康顏色用 per-theme token（`--status-healthy/slow/unstable/dead`），**刻意與 agent 的 `--agent-*` severity 分離**為獨立 palette。
2. **cleanup lease**：agent-server 收到 ping 即 touch version dir + `apps/<appId>` 的 `.heartbeat`（投影/部署的回收租約，見 `deployment#1`）。
3. **dead 偵測**（連續漏拍）：只回報 UI，**不做 auto-kill**（為什麼見 `connection-health#2`）。

時間：心跳 1m、reclaim TTL 1d（`SHELF_HEARTBEAT_INTERVAL_MS` 可覆寫給 E2E）。

**Do not change casually because**：heartbeat RTT **不可跨兩端時鐘比較**（無時間校正）—— 只能 client 單邊算，server 時鐘不進比較。

**Related**：`connection-health#2`、`connection-health#3`、`deployment#1`、`skills#1`、`src/main/agent/{remote,connection-health}.ts`、`agent-server/{index,cleanup}.ts`、`src/renderer/components/Sidebar.tsx`。

## connection-health#2 — 跨睡眠連線存活：不做 client auto-kill；ssh-only idle-shutdown watchdog  ·  [Decision]

**Problem**：連線判 `dead`（連續漏拍）後該不該清掉 session？兩個方向 —— client auto-kill（殺 session）、server self-exit（agent-server 自殺）。

**Reason（為什麼不 auto-kill）**：筆電睡眠每 ~16–17min 一個 dark-wake 循環，整夜數十次；每次睡眠都因「時鐘跳 + timer 沒跑」產生**假掉拍**（`healthy→dead lastAckAgo≈1000s`），但**醒來幾 ms 內就 `dead→healthy`、RTT 正常 —— 連線從未真的故障**。所以「dead 就殺」會一晚殺掉數十個健康 session。

**Decision**：
- **不採用 — client auto-kill on dead**：上述睡眠假象是最強反證；且 **local/docker/wsl 與 client 共命**（同機/同機 VM 一起 suspend），dead 期間 server 也睡著、沒資源可回收。維持「只回報 UI、不殺」。
- **採用 — ssh-only agent-server idle-shutdown watchdog**：判準是 **host 與 client 是否共命**，不是 local-vs-remote：
  - local / docker / wsl → 共命，一起睡 → 不需要（就算 arm，suspend 時 timer 凍結也不會 fire）。
  - **ssh** → 獨立遠端主機，筆電睡時仍在空轉吃資源 → 該自我了結。
  - 機制：watchdog 住 agent-server（`--idle-shutdown-min=N`），收 `ping` reset、逾時 → `dispose backends + process.exit`。**只有 ssh spawn path 帶這個 arg**（`remote.ts`），其他 transport 天然豁免。
  - config：`SSHConnection.idleShutdownMinutes?`（per-remote，**單位分鐘**）。`0` / 明確關 = always keep alive；ssh 未設 → 預設 5min。
  - 門檻取捨：5min = 5× ping 間隔 → 清醒使用不誤觸發；但 5min < dark-wake gap（~16min）→ **ssh 睡下去 ~5min 後遠端就自殺**（= 預期：ssh 不為睡眠 client 守著）。**代價：遠端在跑的背景任務會死**，醒來 respawn + resume（`lastSessionId`）。要保留就把該 remote 設 `idleShutdownMinutes: 0`。

**Do not change casually because**：
- 別加 client auto-kill on dead（睡眠假 dead，一晚殺數十次健康 session）。
- 別對 local/docker/wsl 套 watchdog（共命、無意義；只 ssh）。
- watchdog 門檻別設成「< dark-wake gap 但又想保留睡眠中的遠端背景任務」—— 想保留就 `idleShutdownMinutes: 0`。

**Related**：`connection-health#1`、`background-tasks#1`（醒來 resume）、`src/shared/types.ts`（`SSHConnection.idleShutdownMinutes`）、`src/main/agent/remote.ts`、`agent-server/index.ts`、`scripts/smoke-watchdog.mjs`。

## connection-health#3 — 啟動 sweep × 投影順序：未 touch `.heartbeat` 的 `apps/<appId>` 被當 orphan 刪掉  ·  [Gotcha]

**Symptom**：剛投影/同步、但 `.heartbeat` 還沒建的 `apps/<appId>` 被 agent-server 刪掉 → skill 瞬間消失。

**Root cause**：agent-server **啟動時** sweep 跑在第一拍心跳**之前**，且當下 `lastAppId` 未知 → 把沒 `.heartbeat` 的 `apps/<appId>` 當 orphan 回收。

**Fix**：**投影/sync 時就 touch `apps/<appId>/.heartbeat`**（投影本身就是 liveness 訊號，不必等第一拍 ping）。docker E2E `agent-deploy-skills.spec.ts` 涵蓋此 case。（version dir 無此問題：有 fresh `.deployed` fallback + current/floor 保護。）

## connection-health#4 — 連線 wedge 後無自動復原；沿 wire-tx→wire-rx→session-event→agent-rx trace 定位  ·  [Gotcha]

**Symptom**：agent 執行中筆電闔蓋 + 斷網 → 醒來顯示錯誤；發 `Continue` 後 tool **實際有跑成功**，但 result 一直到不了 renderer，直到手動 disconnect→connect 才正常。

**Root cause（已確認的架構缺口）**：斷線後**沒有任何偵測/自動復原**。health tracker 算得出 `dead`（`connection-health#1`）卻只拿去畫狀態燈（`Sidebar.tsx`）；`proc.on('exit')` 只記 log；`sendLine` 對死掉的 stdin 照寫。所以連線一旦 wedge，只有手動 disconnect→connect（`destroySession` → 全新 `wrapProcess`：重建 stdout `buffer` + `dispatcher` + provider SDK 狀態）能清掉。**local 尤其要注意**：app↔agent-server 是同機 OS pipe，會撐過睡眠；斷網打到的是 agent-server 子行程「裡面」provider SDK 的對外 API 呼叫 → 那條 in-flight streaming 壞掉可能讓 provider/pipe 進 wedged 態，pipe 撐過但事件不流。

**如何定位（不猜；把 logLevel 設 `debug` 重現一次）**：event 走 provider→pipe→main→renderer，每一跳都有 trace（預設關）：
- `wire-tx`（`agent-server/index.ts` `send`）— provider 到底有沒有把該 event 寫出 stdout。
- `wire-rx`（`remote.ts` stdout loop）— main 有沒有從 pipe 收到；配 `stdout buffer residual`（截斷/desync）。
- `pong` / `ping` — 醒來後 pong 有沒有恢復 → 區分「pipe 活、provider wedge」vs「pipe/transport 死」。
- `session-event`（`turn-dispatcher.ts`）— 顯示內容（tool result / reply / stream）有沒有走到 session sink（顯示內容是 session-scoped、不經 per-turn generator）。
- `agent-rx`（`agentTabSubscriptions.ts`，經 `debugLog`→main log，info 即現）— 有沒有跨過 IPC 到 renderer store。
- 判讀：`wire-tx` 有、`wire-rx` 無 = 傳輸中掉（pipe/睡眠）；`wire-rx`/`session-event` 有、`agent-rx` 無 = IPC 沒過；`agent-rx` 有卻沒渲染 = renderer 端（`buildAgentMsg`/store）。`sendLine to non-writable stdin` warn = 送到死 pipe。

**現況**：復原策略（自動 respawn vs 明示 reconnect 提示）與確切 wedge 點**待這輪 trace 重現後再定**。此條先記缺口 + 診斷路徑。

**Related**：`connection-health#1`（heartbeat / dead 偵測）、`connection-health#2`（跨睡眠：不做 client auto-kill）、`agent-core#8`（每個 send 必以 idle 收尾）、`src/main/agent/{remote,index,turn-dispatcher}.ts`、`agent-server/index.ts`、`src/renderer/agentTabSubscriptions.ts`。
