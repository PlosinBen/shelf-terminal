---
type: context
title: Connector
related:
  - architecture/connection-lifecycle
  - contracts/connector-interface
  - context/file-transfer
  - context/terminal-pty
  - context/external-url-intent
---

# Connector

> 跨 connection type（local / SSH / Docker / WSL）的統一抽象層：factory 依 connection type + OS 分流，所有 connection-specific 邏輯（spawn、listDir、upload、exec、cleanup）收在各自實作裡；消費端不感知 type。

## connector#1 — Connector 抽象層（Factory Pattern）  ·  [Decision]

**Decision**：`src/main/connector/index.ts` 的 `createConnector(connection)` 根據 connection type + OS 回傳對應實作。IPC handler 呼叫 factory 取得 connector 再操作。Preload 只是 RPC bridge，不含 dispatch 邏輯。

**Reason**：所有 connection-specific 邏輯（spawn、listDir、upload、cleanup）收在各自的 connector 實作裡，消費端（pty-manager、file-transfer、IPC handler）不需要 switch connection type。新增 connection type 只需加一個 connector 檔案 + 註冊到 factory。

**Do not change casually because**：如果把 connection dispatch 散回各消費端，每個用到 spawn/listDir/upload 的地方都要重複 switch。

## connector#2 — SSH ControlMaster Multiplexing  ·  [Decision]

**Decision**：SSH 連線使用 `ControlMaster=auto` + `ControlPersist=600`，同 project 多個 tab 共用 TCP 連線。

**Reason**：避免每開一個 tab 都重新認證和握手。600 秒 persist 讓短暫斷開的 tab 不需要重連。

**Do not change casually because**：不用 ControlMaster 的話每個 tab 獨立 SSH 連線，開 5 個 tab = 5 次認證。

## connector#3 — Connector exec() 方法  ·  [Decision]

**Decision**：`Connector` 介面加 `exec(cwd, cmd)` 方法，用於在目標環境執行非互動式指令（如 git 操作）。各 connector 實作對應的 execFile 呼叫。Git IPC handler 透過 connector.exec() 執行，不直接暴露 exec 到 renderer。

**Reason**：git worktree 操作需要在遠端（SSH/Docker）執行指令，透過 connector 抽象層可以統一處理，不需要針對每種 connection type 寫不同的 git 邏輯。只暴露特定 git IPC channel 而非通用 exec，避免安全風險。

**Do not change casually because**：不要在 preload 暴露通用 exec API。

## connector#4 — Branch 切換用 connector.exec()，Worktree branch 跳轉而非 checkout  ·  [Decision]

**Decision**：branch 切換用 `connector.exec('git checkout')`，前置用 `git status --porcelain` 檢查 dirty 狀態。Worktree-occupied branch 點擊跳轉到對應 project（或自動建立），不嘗試 checkout。

**Reason**：Worktree branch 不能 checkout（git 限制）。用隱藏 tab 跑 git 指令的話 shell exit code 不可靠。

footer 重設計後，BottomBar 的 branch **顯示/dropdown UI 已移除**（更新時機不可靠：每次讀都 shell out 到 connector，SSH/Docker 慢且切換後無可靠 refresh 時機）。但**切換 side-effect 邏輯休眠保留** — `SWITCH_BRANCH_EVENT` 的 handler 仍在 App.tsx（含上述 checkout + dirty 檢查 + worktree 跳轉），常數仍 export 自 `BottomBar.tsx`。日後要恢復 branch UX，接個觸發點重發 `SWITCH_BRANCH_EVENT` 即可，不必重寫切換邏輯。

**Do not change casually because**：不要用隱藏 tab 跑 git checkout。**不要因為「沒人 emit」就刪掉 App.tsx 的 `SWITCH_BRANCH_EVENT` handler 或 BottomBar 的常數** — 是刻意休眠保留。

## connector#5 — WSL 雙重 Prompt  ·  [Gotcha]

**Symptom**：WSL 連線後 terminal 顯示兩次 `user@host:~$`。

**Root cause**：`wsl.exe --cd /path` 啟動時 shell profile 載入一次印 prompt，然後 login shell 又印一次。

**Fix**：改用 `wsl.exe -d distro -- bash -l -c "cd /path && exec $SHELL -l"`，只有一個 login shell。

## connector#6 — 部署 home 必須可靠解析成絕對路徑  ·  [Gotcha]

**Symptom**：部署或 skills mirror 若使用 `~` 或猜測的 home，控制指令與檔案傳輸可能落到不同位置。

**Root cause**：POSIX shell 不展開引號內的 `~`；picker 用的 `homePath()` 又可能在查詢失敗時回傳 `/home/<user>`、`/home` 或 `/`，這些 fallback 不能當作可寫入的部署來源。

**Fix / note**：deploy 與 out-of-band skills sync 先呼叫 connector `resolveHomePath()`，遠端查詢失敗、空值或非絕對路徑必須 reject，部署在解析成功前不得寫入。Picker 的 `homePath()` 保留既有 fallback 行為。Deployment 的 target commands、檔案路徑與 skills placement 都以實際 home 定址。

## connector#7 — SSH 部署與 terminal 共用 connector 認證選項  ·  [Decision]

**Decision**：部署、skills 控制指令、dispatcher 與 per-tab agent process 全透過 connector。SSH terminal、exec、copyFile、spawnProcess 共用 `ssh/options.ts`：Unix 使用同一條 hashed ControlPath，各 app OS 使用 Shelf known_hosts 與 accept-new policy。

**Reason**：agent 自組 SSH 選項會另開連線，無法沿用 project connect 已認證的 master，並可能使用另一份 host-key policy。密碼 project 可以登入但部署失敗，正是這個邊界分歧造成。

**Do not change casually because**：不要在 agent deploy 再建 SSH argv 或傳遞密碼。Unix 的 password-only deploy 依賴既有 project-connect 先認證，不要求 terminal tab。Windows SSH 每次操作仍獨立連線，`connect()` 只驗證一次登入，不能據此保證後續 password-only 部署。連線失效由現有 caller 回報／重試，connector 不新增 secret 儲存或認證流程。

## connector#8 — 本機 execFile connector 靠 `process.env.PATH` backfill 找 binary，不逐點注入  ·  [Decision]

**Symptom**：從 Finder/Dock 開的打包 app，Docker 連線的容器列表空白（"No running containers found"），log 是 `docker listContainers: spawn docker ENOENT`。從終端機啟動則正常。

**Root cause**：macOS GUI app 繼承的是精簡 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`），不含 `/usr/local/bin`、`/opt/homebrew/bin`。docker connector 的互動終端機（`createShell` 的 `pty.spawn`）有帶 `env: getShellEnv()` 所以 OK，但所有 `execFile('docker', …)`（`listDockerContainers` / `isConnected` / `exec` / `listDir` / `homePath`）都沒帶 `env` → fallback 到精簡 `process.env` → 找不到 `docker` binary。

**Fix（源頭校正，不逐點注入）**：`shell-env.ts` 的 `applyResolved()` 在解析出 login-shell env 後，把 PATH **union 回 `process.env.PATH`**（`mergePathDirs`，resolved 優先、保留既有、去重）。這樣所有「跑在預設 env 上的本機 `execFile`」（docker/ssh/git…）一次到位、**call site 一行都不用改**。分層：要「整套 login env（含 LANG）」的顯式拿 `getShellEnv()`（互動 pty / agent-server）；只要「找得到本機 binary」的靠已校正的 `process.env`。跟既有 `ensureUtf8Locale` 注入 LANG 同性質（把 app 本機環境校正成登入環境）。

**注意**：
- prime 是**非同步**（`primeShellEnv()` 開窗後才跑），理論上「prime 未完成就先呼叫本機 execFile」會拿到未校正 PATH；實務上連線 picker 都在啟動後很晚才開，且 `getShellEnv()` 有 sync fallback 會強制 resolve（連帶 patch `process.env`）。
- 只 merge PATH（不整包覆蓋 `process.env`），避免丟掉 Electron 設的其他 var。
- **測試**：mutate `process.env.PATH` 是全域 side effect，測試需 snapshot + `afterEach` 還原，否則跨檔污染變 flaky。

## connector#9 — ConnectorConfig、ConnectorRuntime 與 AppOS 分離，target facts 不持久化  ·  [Decision]

**Decision**：persisted config 只保存 `local` / `ssh` / `docker` / `wsl` 與其參數。ConnectorRuntime 只管 protocol/lifecycle 並提供 generation identity；AppOS adapter registry 只管 Shelf 所在 OS 如何 materialize executable、argv、cwd、env，registry membership 同時是 structural support list。Target OS/default shell 由 terminal-owned resolver lazy probe，對每個 live runtime generation single-flight cache success 或 failure；generation invalidation 後才重試。

**Reason**：connector 是連線方式，不能從 SSH/Docker/WSL 推斷 remote OS；`ssh` 與 `ssh.exe` 又是 client OS execution detail，不應進 config。分層後 connector 不需混入 app OS branch，runner 也不需重建 transport arguments。

**Do not change casually because**：probe failure 必須採用 connector 產生的 opaque compatibility launch plan，不能改猜 `/bin/sh`、另一個 connector 或 client platform default。單 tab dispose 只取消自己的 wait，不得取消 generation-owned shared probe；disconnect/reconnect 的 stale completion 不得寫入新 generation。

## connector#10 — 大型部署檔案保留原生 file-path transfer  ·  [Decision]

**Decision**：`copyFile(localPath, targetPath)` 由 connector 實作 Local fs copy、SSH SCP、Docker cp、WSL mount-path cp；remote transfer 有 180 秒 timeout，caller 負責建立 target parent。小型投影／upload 仍使用 `putFile(Buffer)`。

**Reason**：runtime payload 可達數百 MB。把 transport ownership 移入 connector 即可修正認證分歧；同時改成讀整份 Buffer 或另設串流 API，會引入記憶體／搬運策略變更。保留原生工具可縮小遷移風險。

**Do not change casually because**：`copyFile` 不負責 manifest、sentinel、chmod、lease 或 mirror；這些仍由 deploy 編排。改用 Buffer／cat-pipe 前必須量測代表性 payload 的記憶體與傳輸表現。

## connector#11 — Agent process 使用 pipe process，不使用 terminal Shell  ·  [Decision]

**Decision**：connector `spawnProcess` 回傳普通 Node process handle，保留獨立 stdin/stdout/stderr、error/exit events 與 stream lifecycle。Dispatcher 和 per-tab fallback 共用同一個 agent startup builder；connector 處理 executable transport、quoting 與 env materialization。

**Reason**：agent stdout 是 wire protocol；PTY 的 terminal 合併輸出與控制行為不適合替代 pipe。普通 process handle 已滿足現有兩個 protocol consumers，額外事件 wrapper 沒有目前需求。

**Do not change casually because**：local executable 選擇及 `ELECTRON_RUN_AS_NODE=1` 是 agent runtime policy；SSH idle watchdog 也是 agent policy。Shared dispatcher 不接收 project env，per-session env 仍經 `open_session` 傳入；direct process 才在啟動時注入。Connector 不解析 provider 或 agent protocol。
