---
type: context
title: Connector
related:
  - architecture/connection-lifecycle
  - contracts/connector-interface
  - context/file-transfer
  - context/terminal-pty
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

## connector#6 — Deploy-plane 的 `sshOps.base` 必須解析成絕對 `$HOME`，不能用 `~`  ·  [Gotcha]

**Symptom**：SSH 上 app-level skills 同步**完全沒生效**（檔案沒落地、`.synced` gate / `.heartbeat` lease / delete-mirror 全失靈）；docker / wsl 正常。

**Root cause**：`agent/remote.ts` 的 deploy plane（`RemoteOps`）用 `ops.exec` 跑 `mkdir -p "<base>/.shelf/..."` 這類指令，base 早期是 `'~'`。**`~` 在雙引號內，POSIX sh 不展開** → 指令打到字面目錄 `$HOME/~/.shelf/...`（垃圾路徑）。而 scp（`copyIn`）會在遠端展開 `~`，但 scp **不建中間目錄** → 父目錄（剛剛被 `mkdir` 建到垃圾路徑）不存在 → per-file scp 失敗 → 被 best-effort catch 吞掉。docker(`/root`)、wsl(已解析絕對 `$HOME`)用絕對 base 所以沒事 —— 也因此 docker-based e2e 從沒抓到。

**Fix**：`sshOps` 在建立時就 `exec('echo "$HOME"')` 解析**絕對 `$HOME`** 當 `base`（照 `wslOps` 既有寫法）。這樣 deploy-plane 的 control 指令與 byte path（skills 現在走 transport `putFile`，用 `connector.homePath()` 解析的絕對 home）一致。**新增任何用 `ops.base` 組的 `ops.exec` 指令時，記得 base 是絕對路徑、別再塞 `~`。**

## connector#7 — Deploy-plane `sshOps` 與 connector 的 ControlPath 不同、且不帶密碼 → ssh 部署實質需 key auth  ·  [Gotcha]

**Symptom**：對「只有密碼認證」的 ssh 目標，agent-server 完整部署（ship binary）跑不起來 —— 換句話說 ssh agent-deploy 的 e2e 沒法用密碼容器跑。

**Root cause**：connector 的 authenticated ControlMaster 在 **hashed** path（`<tmp>/shelf-ssh/<sha256>`，見 `ssh-control.getControlPath`），但 deploy plane 的 `sshOps` 用**另一條 unhashed** path（`/tmp/shelf-ssh-<host>-<port>-<user>`）且**不帶密碼** → 它不會重用 connector 的 master，又無法非互動認證。

**現況**：屬**已知、未修**的 pre-existing 議題，超出 transport 收斂範圍。實務上 ssh agent-deploy 仰賴 key/agent 認證；純密碼部署會失敗。日後若要修：讓 `sshOps` 重用 connector 的 hashed master，或把認證 thread 進 deploy plane。**別假設 ssh 部署在純密碼下能動。**

## connector#8 — 本機 execFile connector 靠 `process.env.PATH` backfill 找 binary，不逐點注入  ·  [Decision]

**Symptom**：從 Finder/Dock 開的打包 app，Docker 連線的容器列表空白（"No running containers found"），log 是 `docker listContainers: spawn docker ENOENT`。從終端機啟動則正常。

**Root cause**：macOS GUI app 繼承的是精簡 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`），不含 `/usr/local/bin`、`/opt/homebrew/bin`。docker connector 的互動終端機（`createShell` 的 `pty.spawn`）有帶 `env: getShellEnv()` 所以 OK，但所有 `execFile('docker', …)`（`listDockerContainers` / `isConnected` / `exec` / `listDir` / `homePath`）都沒帶 `env` → fallback 到精簡 `process.env` → 找不到 `docker` binary。

**Fix（源頭校正，不逐點注入）**：`shell-env.ts` 的 `applyResolved()` 在解析出 login-shell env 後，把 PATH **union 回 `process.env.PATH`**（`mergePathDirs`，resolved 優先、保留既有、去重）。這樣所有「跑在預設 env 上的本機 `execFile`」（docker/ssh/git…）一次到位、**call site 一行都不用改**。分層：要「整套 login env（含 LANG）」的顯式拿 `getShellEnv()`（互動 pty / agent-server）；只要「找得到本機 binary」的靠已校正的 `process.env`。跟既有 `ensureUtf8Locale` 注入 LANG 同性質（把 app 本機環境校正成登入環境）。

**注意**：
- prime 是**非同步**（`primeShellEnv()` 開窗後才跑），理論上「prime 未完成就先呼叫本機 execFile」會拿到未校正 PATH；實務上連線 picker 都在啟動後很晚才開，且 `getShellEnv()` 有 sync fallback 會強制 resolve（連帶 patch `process.env`）。
- 只 merge PATH（不整包覆蓋 `process.env`），避免丟掉 Electron 設的其他 var。
- **測試**：mutate `process.env.PATH` 是全域 side effect，測試需 snapshot + `afterEach` 還原，否則跨檔污染變 flaky。
