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

**Related**：`connection-health#1`（heartbeat / dead 偵測）、`connection-health#2`（跨睡眠：不做 client auto-kill）、`connection-health#7`（dispatcher 路徑的兩層 health + connection-centric reconnect，取代此條缺口）、`agent-core#8`（每個 send 必以 idle 收尾）、`src/main/agent/{remote,index,turn-dispatcher}.ts`、`agent-server/index.ts`、`src/renderer/agentTabSubscriptions.ts`。

## connection-health#5 — 逃出 tree 的 detached 背景任務：正常關閉一律自收（不分意圖）  ·  [Decision]

**Problem**：agent 的背景 shell 任務（Bash `run_in_background`）是 **detached（`setsid`）** spawn 的，會離開 agent-server 的 process tree、reparent 到 PID 1。所以 agent-server 收尾時的 **stdin-EOF 級聯碰不到它們** → agent-server 關掉後這些任務在 (遠端) host 洩漏：long-lived 的（dev server）會 **compound**（N 個 session → N 個殭屍 server）+ **collide**（佔住 `:3000` 讓下個 session 綁不上）。tree **內**的東西（CLI、MCP、前景 bash）都被級聯收掉，逃出去的 detached 任務是唯一殘留。

**Decision**：以 **provider 視角**分「**正常 vs 不正常關閉**」，判定權在 **agent-server 自己**（不是 main 送意圖）：
- **正常關閉 = agent-server 還活著、要退出**（不管哪個原因：關 tab / 關 app / main crash 收到 stdin-EOF、或 **idle watchdog**（`connection-health#2`）觸發）。共通點是它跑得動 shutdown → **在每個退出口自我收屍**：`rl.on('close')` 與 watchdog 都路由到單一 `shutdown()`（`agent-server/shutdown.ts` `performShutdown`）→ enumerate `ServerBackend.listReapableTasks()` → 對還 `running` 的 shell 任務呼 `stopTask(id)`（集中在 `agent-server/reaper.ts`，**不**放各 provider `dispose()`，故 `dispose()` 簽名不變、政策單一處）→ dispose → exit。收屍是 host-local（CLI 是 agent-server 本地 child），所以「main↔遠端網路斷了」也收得掉。
- **kill = `stopTask(id)`，reaper 對所有 provider 一致**：但 **Copilot SDK 沒有 stop-task RPC**（只有 Claude 有 `session.query.stopTask`）。解法：Copilot 的 `stopTask` 走 detached bash 寫的 **`.pid` 檔**（`echo $$ > '<logPath .log→.pid>'`，`detached:true` 使其為 session/group leader）→ `process.kill(-pid, SIGTERM)` 收整個 group。能力差異**藏進 provider**，reaper 不分支。
- **main 端只 `dispose()`**（無 reap 意圖訊號）；`remote.ts` `kill()` 保留一個 **unref'd grace-backstop** 再 force-kill —— 只因 child 的 reap 是 **async**（立即 SIGTERM 會切斷），**不是**用來帶意圖。

**Reason（為何斷線也一律收、不「保留等重連」）**：**沒有重連機制** —— reconnect 是**全新連線 = 新 agent-server = 新 CLI**，舊 session 永遠回不來；且斷線期間 emit 的 agent action **不落紀錄**，就算任務跑完也不可見。所以被保留的 detached 任務 = 永久看不到、控不到的孤兒 → 斷線即收。（推翻早期「intent-driven / reconnect re-attach / reconnect-window」設計。）對照基準：`ssh + CLI` 前景跑，斷線 SIGHUP 也是殺掉 agent 本身，我們只是把它逃出去的孤兒也一起收乾淨。

**Do not change casually because**：
- 別回到 main→child 的 reap 意圖訊號（agent-server 自己就知道自己在正常關閉；main 只 dispose）。
- 別把 reaper 塞進各 provider `dispose()`（enumerate→kill 政策要單一處）。
- 斷線別「保留任務等重連」（沒有重連機制）。
- Copilot 收屍別假設有 stop-task RPC —— 沒有，走 `.pid` group-kill。

**Related**：`connection-health#2`（watchdog / 遠端背景任務存活）、`connection-health#6`（crash net）、`background-tasks#3`（`stopTask` 全鏈）、`background-tasks#4`（UI 面板刪除 / 隱形 orphan 的 renderer 對應）、`agent-providers#1`（provider 封裝）、`agent-server/{shutdown,reaper,exec}.ts`、`agent-server/providers/{types,claude/index,copilot/index,copilot/pid-kill}.ts`、`src/main/agent/{index,remote,types}.ts`。

## connection-health#6 — Crash net：agent-server 死掉那種，靠 env-tag + 下次啟動 `/proc` sweep（含 runtime-env gotcha）  ·  [Decision]

**Scope**：唯一的「**不正常關閉**」= agent-server **自己**硬 crash / 卡死被 force-kill（來不及跑 `connection-health#5` 的正常 shutdown）。此時 provider CLI 因 stdin-EOF 自退，但它逃出去的 detached 任務變孤兒、**沒有活著的 supervisor 收**。這是唯一需要外部 backstop 的情況（罕見）。

**Mechanism（env-tag lease + startup sweep，比照 `cleanup.ts` 的 disk-dir sweep 時機）**：
- 開機時 agent-server 把 `SHELF_SESSION=<uuid>` 設進**自己的 `process.env`**（spawn 的 CLI + detached 任務都繼承，見 P0.5 兩跳 env 傳遞）；並寫一份 lease `~/.shelf/agent-sessions/<uuid>.json`（記 `ownerPid` + **start-time**）。
- **正常關閉會刪掉自己的 lease**（已收屍）→ **殘留 lease ⇒ crash**。
- 下一個 agent-server 開機（寫自己 lease 之前）跑 startup sweep：對每個 lease，**owner 還活著就跳過**（含並發的 sibling agent-server）；owner 死了 → 用 `/proc/*/environ` 找還活著、帶該 tag 的孤兒 → group-kill → 刪 lease。per-session uuid 保證只碰死掉那個 session 的任務。
- **Linux-only**：需 `/proc`；macOS/Windows 無 → sweep no-op（macOS 本機硬 crash 的孤兒不自動收；**接受**：罕見 + 使用者看得到 `lsof`/Activity Monitor）。env-tag 用 `/proc` 找孤兒 → 不需 cgroup（P0.5 已證 env 傳遞可行）。child→main 的 `{closing}` marker 不做（lease 有無已足以分辨 clean vs crash）。

**Gotcha（踩過，只有真 `/proc`（Docker/Linux）驗得出）**：Node **執行期**設的 `process.env.X = …` **不會**出現在自己的 `/proc/<pid>/environ` —— 那個檔是 **exec 當下的快照**。所以「用 owner 自己的 env tag 判 owner 生死」永遠 false → 會把 **live session 誤判成死、誤殺它的任務**。而 spawn 出去的**子程序**在 exec 時就帶到 runtime env（故用 tag 找**孤兒任務**沒問題）。→ **owner 生死改用 pid + `/proc/<pid>/stat` start-time**（防 pid-reuse），不靠 owner 的 env tag。**fake-`/proc` 單元測抓不到**（測試在假 environ 寫了 tag）—— 只有 `node:20-alpine` 跑真 `/proc` 才現形；已有 **Linux-gated 回歸測試**守住。注入點必須是 **agent-server 自己的 `process.env`**（不是 main spawn env —— ssh 預設不轉發 env，遠端會收不到）。

**Do not change casually because**：
- owner 生死別用它自己的 env tag（runtime-set env 不進 `/proc/environ`）—— 用 pid + start-time。
- `SHELF_SESSION` 注入點是 agent-server 自己的 `process.env`（ssh 不轉發 → 別改成 main 在 spawn env 給）。
- 別預期 macOS 自動收 crash 孤兒（無 `/proc`，已接受）。

**Related**：`connection-health#5`（正常關閉自收）、`connection-health#3`（startup sweep × 投影順序）、`deployment#1`（heartbeat-lease disk sweep）、`agent-server/{proc-scan,session-sweep,exec}.ts`、`agent-server/{proc-scan,session-sweep}.test.ts`（含 Linux-gated 真 `/proc` 回歸測）。

## connection-health#7 — Dispatcher 路徑：兩層 health + connection-centric reconnect（fail-loud 先於重連）  ·  [Decision]

> 適用於 dispatcher 路徑（`architecture/agent-dispatch`），現為預設。舊的 per-session 直連 path 仍以 flag 保留為**過渡 fallback**（移除已列管）——此條描述的是預設現況，fallback 移除時只需刪掉對它的提及。

**兩層 health（取代 `connection-health#4` 記的「wedge 後無自動復原」缺口）**：
- **OUTER（host 層）**：app ↔ per-host dispatcher 一拍 heartbeat（一 host 一拍，非 per-session）。漏拍 = 整台 host 不可達 → **一次砍掉該 host 所有 session**（它們共用一條 channel，砍整台是正確粒度）。取代舊的 per-session heartbeat。
- **INNER（per exec）**：dispatcher ↔ 每個 exec 在遠端本機一拍 heartbeat。漏拍 = 該 exec **hung**（活著但 event loop 卡死 —— 睡眠/斷網 wedge）→ **只砍那一個 session**，dispatcher 與 sibling 不動。
- **INNER 為何必要（非可選）**：少了它，wedged exec 仍騎在一個對 outer 照樣回 pong 的 dispatcher 下 → app 看到 host healthy 卻有一 tab 靜默卡死，正是 `connection-health#4` 的舊缺口。stream-silence 不能替代 probe（idle tab 本來就靜默）。

**Connection-centric reconnect（不是 respawn）**：dispatcher 對**每個 session** 維持一條到 provider execution 的活連線；isolated 下 exec process 只是這條連線當下的化身。連線斷（exit=「gone」/ inner-probe 無回=「no response」）→ dispatcher 把該 session **reconnect 到一個全新 exec**；因對話已持久化（provider 自身的 resume id），重連的 exec **resume 同一個邏輯 session**，非重生。此框架能推廣到 shared（reconnect 到 client），「respawn 一個 worker」不能。

**Ordering：fail-loud 先，reconnect 後**（order-critical）。exec down 時 dispatcher **先** 把該 session 所有 in-flight turn 大聲失敗掉（renderer 顯示 turn interrupted、spinner 解卡、清掉任何開著的 permission prompt），**才** 拉起新 exec 並更新 mapping。mid-turn work 一定丟 —— 從上一個 committed turn 邊界 resume，**絕不靜默留白**。無回應的 exec 直接 SIGKILL（它不會處理 stdin-EOF）。反覆重連失敗 → backoff 遞增到 cap；超過 cap 停手、host 退回既有 disconnected 狀態。

**Do not change casually because**：
- INNER ping 只是 liveness probe —— 別把 heartbeat 的 side-effect（idle watchdog reset / lease touch）留在 exec；那些上移到 dispatcher（見 `deployment#1` lease、`architecture/agent-dispatch`）。
- reconnect 一定 **fail-loud 先於重連** —— 顛倒順序會讓 renderer 把 in-flight turn 的失敗誤當新 exec 的事件，或漏掉「turn 已丟」的通知（回到 `connection-health#4` 的靜默 wedge）。
- 別把 dispatcher 的 outer 漏拍改成只砍單一 tab —— 共用 channel 死掉時整台 host 都不可達，砍整台才對。

**Related**：`connection-health#1`（heartbeat 基礎）、`connection-health#4`（此條修掉的舊缺口）、`connection-health#8`（reconnect 的 health-seed gotcha + dispatcher death）、`contracts/agent-wire-protocol`（Boundary 1 `session_down{sid,reason,willReconnect}` + host-level ping/pong）、`architecture/agent-dispatch`。

## connection-health#8 — Reconnect 必須 SEED 'healthy'，否則舊的紅燈永不清；dispatcher death = host disconnect + Retry  ·  [Gotcha]

**Symptom**：exec/dispatcher 崩潰讓某 tab 轉 `dead`（紅），重新 init 成功後 tab **仍是紅的**，健康度回不來。

**Root cause**：health model 是「**沒 entry = healthy**」，且 heartbeat **只在「從 healthy 變壞」時 emit `onHealth`**。一條剛 reconnect 的連線因此**從沒推過 'healthy'** → 之前在崩潰時被標 'dead' 的 tab 就永遠停在紅色，即使 re-init 已成功。

**Fix**：`DispatcherConnection.openSession` 在（re)connect 時，用 tracker 當下（樂觀 healthy）的讀數 **seed 該 session 的 `onHealth`**，主動推一次 'healthy' 把陳舊紅燈清掉。（per-session 直連 fallback 有同樣的潛在形狀，但 store 預設值遮住了它，範圍最小化不動它。）此 seed 是 recovery overlay 能自清的前提（見 `agent-ui#7`）。

**Dispatcher death = host-level disconnect（非新失敗模式）**：dispatcher 崩潰**不是**嚇人的新 blast radius —— 它退回**既有的 disconnected 狀態**，只是粒度更粗（該 host 所有 session 一起 disconnect，對共用一條連線的 session 是正確的）。**不自動復原**（設計如此：遠端沒有東西 supervise dispatcher，它本就隨 owning app 的 channel 而生滅，見 `architecture/agent-dispatch`）→ 使用者按 **Retry**（或開一個 tab）就 spawn 全新的。Retry-not-auto 是刻意的，對齊今日 per-session 崩潰的 UX。

**Do not change casually because**：
- 別移除 reconnect 的 health-seed —— 少了它，成功重連後紅燈永不清（heartbeat 不會為「沒變壞」補發 healthy）。
- 別給 dispatcher 加 daemon self-respawn —— 遠端無人 supervise 它，death=host disconnect 是**既有**可復原狀態，Retry 即重生；自動重生只會多一層無人看管的生命週期。

**Related**：`connection-health#7`（兩層 health + reconnect）、`agent-ui#7`（recovery overlay 靠此 seed 自清）、`src/main/agent/dispatcher-connection.ts`。
