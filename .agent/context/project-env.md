---
type: context
title: Project Env
related:
  - architecture/project-env
  - contracts/ipc-channels
  - context/connector
  - context/config-backup
  - context/agent-providers
---

# Project Env

專案 env 明碼存於 canonical Project.envPlain，注入 Shelf 為該 Project 啟動的
terminal、agent-server 與其子 process。它不是機密儲存介面。

## project-env#1 — Canonical env、單一解析出口  ·  [Decision]

**Decision**：resolveProjectEnv 只讀 canonical Project.envPlain 並 sanitize；terminal
與 Agent 共用同一出口。純驗證、PATH merge 與 export helper 保持 provider-neutral。

**Reason**：儲存來源與注入機制分離，各 connector 不需自行解讀 Project config。

**Do not change casually because**：新增 spawn 面需沿用同一解析出口與保留字政策，
不能從 renderer payload 或其他檔案補入另一套 Project env。

## project-env#2 — 全 spawn 面統一注入；dispatcher 是 per-host → env 走 open_session  ·  [Decision]

**Decision**：注入點是 **Shelf 自己組的 spawn 指令**，涵蓋所有 connector：
- **local**（agent-server + terminal pty）：merge 進 spawn 的 `env` Record（`applyEnvMap`，PATH merge、reserved 丟棄），Shelf-required（`ELECTRON_RUN_AS_NODE`）最後套。
- **docker/ssh/wsl**：pty 的 `env` 只到本機 client 不到遠端 shell → 改在遠端指令前綴 `export K='v'; …`（`buildEnvExportPrefix`，PATH 併成 `:"$PATH"`）。這順帶補上了 docker/wsl 一直缺的統一注入點（init script 本來只有 ssh 認）。

**Gotcha（載重）**：dispatcher 是 **per-HOST 共用**的，per-PROJECT env 不能騎它自己的 process env。改由 `open_session` 訊息帶 `env` → dispatcher 存進 ExecEntry → 套到它 spawn 的 per-session exec proc，**且 reconnect 時重套**（否則重連後注入的 env 會掉）。`spawnLocalNode` 的 projectEnv 參數只有 per-tab agent-server 傳；local dispatcher **不**傳（它的 exec 走 open_session 那條）。

## project-env#3 — precedence：靜默覆蓋、PATH merge、SHELF_ 保留字  ·  [Decision]

**Decision**：ambient/繼承 env `<` project env `<` Shelf-required（最後套，backstop）。project env **靜默覆蓋** ambient（生態系慣例：shell `FOO=bar cmd`、docker `-e`、dotenv、CI、K8s 都是覆蓋不警告；在這裡警告只是噪音）。歧義在**輸入時**擋，不在 runtime：
- **PATH 只 merge 不取代**（project 值前置），取代會打斷 binary 查找。PATH 可設但強制 merge、**不**是保留字。
- **重複變數名稱** → UI inline 顯示錯誤。
- **Shelf-required 是保留字**：`SHELF_*` 前綴 + `ELECTRON_RUN_AS_NODE` + `BROWSER`，單一來源 `SHELF_RESERVED_ENV`（新 `SHELF_*` 自動保留）。UI inline 擋；注入時 Shelf 自己的 var 仍最後套（防手改 config 繞過）。`BROWSER` 對 terminal 指向 Shelf external-URL launcher；這個保證只到 process creation，使用者的 shell profile 或之後手動 export 可再覆蓋，Shelf 不在 startup 後偷偷重設或嘗試鎖死。

## project-env#4 — Retired  ·  [Decision]

**Superseded by project-env#8.**

## project-env#5 — Retired  ·  [Gotcha]

**Superseded by project-env#8.**

## project-env#6 — Retired  ·  [Decision]

**Superseded by project-env#8.**

## project-env#7 — Backup allowlist 是獨立邊界  ·  [Decision]

**Decision**：config backup 只 enumerate Skills／MCP，不會因檔案位於 userData
就順帶備份 Project config、credential 或其他未列入 allowlist 的資料。

**Reason**：明碼與加密都不是備份授權；是否能傳到外部應由 egress allowlist 決定。

**Do not change casually because**：擴大 payload 需逐欄審計，不能直接打包 userData。

## project-env#8 — Project env 不承擔機密保管  ·  [Decision]

**Decision**：Project 編輯只提供明碼 env；沒有 secret editor、IPC、加解密 store、
key 管理、worktree secret 複製或 secret cleanup。不得把機密自動轉存 Project.envPlain。

**Reason**：目前工作流沒有使用 Project 機密 env 管理，卻需要跨平台 key 管理、
獨立儲存結果恢復與 worktree 複製生命週期。這些成本不足以由目前需求支持；
一般 env 注入與 provider 原生認證維持各自責任，不為未出現的需求維持秘密儲存系統。

**Do not change casually because**：Project.envPlain 是明碼，不是機密儲存的安全替代。
MCP endpoint 認證的 runtime signing key／Bearer 是另一條安全邊界，不受此決策影響。

### Gotchas

既有 userData 中的 project-secrets.json、secret-key.local、secret-key.enc 保留原樣：
不讀、不解密、不覆寫、不自動刪除，Project 刪除也不 prune。這些值不再注入新啟動的
process；已啟動 process 的 env 不會因此被清除或自動重啟。保留檔案不是繼續支援
舊 secret schema 或提供恢復 UI；資料處置需由使用者另外決定。
