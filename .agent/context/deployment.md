---
type: context
title: Deployment
related:
  - context/skills
  - context/connection-health
  - architecture/connection-lifecycle
---

# Deployment

> `~/.shelf/` 部署 taxonomy（東西放哪）+ source→server 投影模型（client/server m:n）；agent-server 打包成單一 bundle 推到遠端。

## deployment#1 — `~/.shelf/` 部署 taxonomy + cp-to-remote 投影模型（client/server m:n）  ·  [Decision]

> 一部分是現行實作（agent-server / context），一部分是**規則**（per-app 投影、TTL 清理）。本條是「`~/.shelf/` 要放什麼、怎麼 cp 到 remote」的長期參照規則，新增任何 `~/.shelf/` 內容前先過這條。

**Mental model（既有架構，非比喻）**：app = **client**（本機唯一，持有使用者真相 = `<userData>`）；`~/.shelf/` = **每台機器上的 server data**（agent-server 跑哪、`~/.shelf` 就在哪 —— local 在本機、SSH/Docker/WSL 在遠端）。`remote.ts` 對**每個 connection** spawn 一個 agent-server → **1 client : N servers**；且同一台 server 可被多個 client 連 → 實為 **m:n**。`~/.shelf/` 內容**一律用 `os.homedir()` 定址**（agent-server 拿不到 Electron userData）。

**Taxonomy（決定新東西放哪的唯一準則）= 「跨 app 該不該共享」**：

| identity | 跨 app | 路徑 | 例 |
|---|---|---|---|
| **version**（內容 = 位元組，同版相同）| **該共享**（dedup 大 payload）| `~/.shelf/agent-server/<version>/` | bundle / node / 215MB CLI binary（`deployment#2`）|
| **app**（內容因 app 而異）| **絕不共享**（會互蓋）| `~/.shelf/apps/<appId>/…` | skills 投影、未來 per-app 投影物 |
| server 原生、已被自身 key 隔離 | 不共享 | 暫留原位（可選歸 `apps/`）| agent-context `by sessionId`（`agent-core#4`/`background-tasks#1`）|

- **`<appId>` = `appInstanceId`**：存 `<userData>` 的 UUID、generate-once（同 sessionId 模式）。dev/test/prod 因 userData 隔離而各自獨立 → 共享 server 上不互蓋。

**cp-to-remote 投影模型（source → server data 的統一規則）**：
- **source of truth 永遠在 client `<userData>/…`**（UI 編輯、唯一一份）；server 端是**投影副本**（衍生、可丟、可重建）。
- **消費路徑對 local/remote 一致** = `os.homedir()/.shelf/apps/<appId>/…`；agent-server **零 local/remote 分支**，main 只送 `appId`。**local = 本機 fs cp、remote = scp/docker cp/wsl**（同一機制、不同 transport，複用 `deploySelfContained` 管線）。
- **增量 gate**：頻繁變動的使用者內容（如 skills）用 **content-hash sentinel**（client hash != 遠端 `.synced` 才 re-sync）；不可變的版本化 payload（bundle）用版本目錄 + `.deployed` sentinel（`deployment#2`）。
- **mirror 語意**：投影 = **整包替換**（砍掉重推）→ 自然涵蓋刪除 / rename。投影物可丟，免 migration。
- **Docker 短暫性**：container 重建即丟 → 下次連線 sentinel 不在 → 全量推，self-healing。

**清理一律走 heartbeat-lease sweep，不 eager 互刪**（`agent-server/cleanup.ts`，見 `connection-health#1`）：
- **為何不能 eager 互刪（反例）**：「刪掉除當前版本外所有版本」這種 eager 清理**隱含「一台 server 一個 app」**，在 m:n 下會壞：共享 server 上 app A(v2) 部署會刪掉 app B(v1) 在用的 v1 → B 下次 spawn 重部署 v1 又刪 v2 → **互刪 + 反覆重傳 215MB（thrash）**。
- **正解 = 改清理策略**（非改 key）：live agent-server 每拍心跳 touch `.heartbeat`（version dir + `apps/<appId>` dir）；agent-server **啟動時** `runCleanupSweep` 掃自己機器，回收非 floor、`.heartbeat` 停 >1 天的 version、及無 fresh lease 的 appId。同時保住 **dedup + m:n 安全 + 自清**。詳細參數/觸發/race 修正見 `connection-health#1`/`connection-health#3`。

**Do not change casually because**：
- 不要把 agent-server 改成 appId-keyed —— 殺掉大 binary 的跨 app dedup，且 version 仍得內嵌、沒真的消失（兩個 key 都還在）。
- 不要把 per-app 投影物（skills 等）改成 version-keyed —— 內容因 app 而異，會 m:n 互蓋。
- 不要用 machine-id / `~/.shelf/client-id` 當 `<appId>` —— dev/prod 會共用 id → 互蓋；用 userData UUID 才各自獨立。
- 不要讓 client 直接讀寫遠端 fs —— 投影一律由 client→server 走既有 deploy transport 推（憑證不跨界）；讀遠端僅限自己 deploy 的小 sentinel。
- 不要為 local 開特例直接指 `<userData>` —— 統一投影到 `~/.shelf/apps/<appId>` 才能 local/remote 零分支（agent-server 同一份 code 只能 `os.homedir()` 自解）。

**Related**：`deployment#2`（agent-server bundle deploy + `.deployed`）、`agent-core#4`/`background-tasks#1`（context 持久化 / `os.homedir()` 定址）、`agent-providers#1`（provider 差異封裝）、`skills#1`（App 層 skills + heartbeat：此規則的第一個 per-app 投影實例）、`connection-health#1`（heartbeat-lease sweep）、`src/main/agent/{remote,deploy-layout}.ts`、`agent-server/{cleanup,context-store}.ts`。

## deployment#2 — Agent Server esbuild 單一 bundle + deploy 到遠端  ·  [Decision]

**Decision**：`agent-server/` 用 esbuild 打包成 `dist/agent-server/<version>/index.js` 單一 ESM bundle，deploy 到遠端（SSH: `~/.shelf/agent-server/index.js`，Docker: `/root/.shelf/agent-server/index.js`）。Main process 的 `remote.ts` 自動 SCP / docker cp。

**Reason**：agent-server 依賴 Claude SDK / Copilot SDK，不能期望遠端有 node_modules。Single bundle 讓 deploy 只需要複製一個檔案 + `node index.js`。Binary（claude/copilot CLI）由 main process 從 ASAR unpacked 路徑解析後傳 cliPath 給 SDK。

**Do not change casually because**：不要在遠端跑 npm install —— 會拖慢啟動且需要 network。

**Related**：`deployment#1`（`~/.shelf/` taxonomy，bundle = version-keyed 共享 payload）、`src/main/agent/remote.ts`。

## deployment#3 — SSH deploy 的 port flag：scp 用 `-P`（大寫），不是 `-p`  ·  [Gotcha]

**Symptom**：非預設 port 的 ssh host 上，agent deploy 壞掉（bundle 傳不過去）。

**Root cause**：ssh 與 scp 的 port flag **不同**：`ssh -p <port>` 指定 port，但 `scp` 的 port flag 是**大寫 `-P`**；`scp -p` 意思是 **preserve-times**。曾共用同一組 opts 字串把 `-p <port>` 同時餵給 ssh 與 scp → `scp -p 2222` 把 `-p` 當 preserve-times、把 `2222` 當**來源檔**（source operand）吞掉 → deploy 到非預設 port 的 ssh host 直接爛。長期沒被抓到是因為**沒有 ssh-agent-deploy 的自動化覆蓋**（connector `ssh.spec` 只測 terminal）。

**Fix**：ssh 與 scp 各自組 opts —— ssh 用 `-p <port>`、scp 用 `-P <port>`（其餘 ControlMaster/ControlPath 等相同）。有 unit 迴歸（`sshDeployOptStrings`）。

**Do not change casually because**：別把 ssh/scp 的 opts 字串合併回同一份 —— port flag 大小寫不同（`-p` vs `-P`），共用一定會其中一邊壞。

**Related**：`deployment#2`（bundle deploy via scp）、`src/main/agent/remote.ts`（`sshDeployOptStrings`）。
