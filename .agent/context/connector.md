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
