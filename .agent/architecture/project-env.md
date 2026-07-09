---
type: architecture
title: Project Env Injection
related:
  - architecture/agent-dispatch
  - context/project-env
---

# Project Env Injection

專案層級 env（plain + secret）從設定/儲存 → 解析 → 注入到 Shelf 為該 project 啟動的每個 process 的抽象流。

## 資料流

```
                  plain (明碼設定, 隨 config 同步)
                        \
  單一解析出口  resolveProjectEnv(projectId)  →  一份合併 EnvMap
                        /                              (secret 覆蓋同名 plain)
    secret (加密 side-car) → 依 tier 取 master key → 只解該 project 那段
                                                          │
             ┌────────────────────────────┬──────────────┴───────────┐
             ▼                             ▼                          ▼
      agent-server (per-tab)      agent-server (dispatcher)      terminal (pty)
      local: merge spawn env      per-host 共用 → env 走          local: merge pty env
      ssh/docker/wsl: export      open_session → 套到 per-session  ssh/docker/wsl: export
      前綴 (PATH 併 $PATH)         exec proc (reconnect 重套)        前綴
```

## 要點

- **單一解析出口**：兩個注入面（agent-server、terminal）都只讀 `resolveProjectEnv`；plain 與 secret 在此合併，下游不感知來源類別。secret 只在 main process、注入前一刻解密。
- **注入機制依 connector 分**：本機直接 merge 進 child 的 `env`（PATH merge、reserved 丟棄、Shelf-required 最後套）；遠端（docker/ssh/wsl）因 pty `env` 只到本機 client，改在遠端指令前綴 `export`。
- **dispatcher 是 per-host 共用**：它自己的 process env 裝不下 per-project 值，所以 env 隨 `open_session` 控制訊息過去，由 dispatcher 套到它 spawn 的 per-session exec proc，且 exec 崩潰 reconnect 時重套（見 context/project-env#2、architecture/agent-dispatch）。
- **precedence**：ambient `<` project `<` Shelf-required（backstop）；PATH merge 不取代；`SHELF_*`/`ELECTRON_RUN_AS_NODE` 保留字在輸入時擋。
- **secret at-rest**：AES-256-GCM 值加密 + 可換 master-key tier（OS keychain / 本機 0600 檔 / 永不明碼）；獨立 side-car，不進任何同步/備份路徑（見 context/project-env#4、#7）。
