---
type: context
title: Project Env (plain + secret)
related:
  - architecture/project-env
  - contracts/ipc-channels
  - context/connector
  - context/config-backup
  - context/agent-providers
---

# Project Env (plain + secret)

> 專案層級環境變數：Shelf 注入到它為該 project 啟動的**每個** process（agent-server + 它 spawn 的 CLI、以及互動 terminal）。分 **plain**（明碼存 projectConfig、會同步）與 **secret**（加密 side-car、永不同步）兩類，但兩者解析成**同一份注入 env map**，差別只在儲存與顯示。

## project-env#1 — 兩類 env、單一注入 map、單一解析出口  ·  [Decision]

**Decision**：plain env 存 `ProjectConfig.envPlain`（`Record<KEY,value>`，明碼、跟 projectConfig 一起走）；secret env 存加密 side-car（見 #4）。兩者都經 `src/main/project-env.ts` 的 `resolveProjectEnv(projectId)` 合併成一份 `EnvMap`（secret 覆蓋同名 plain），**兩個 spawn 面（agent-server、terminal）只讀這一個出口**，永遠不知道值是 plain 還 secret。純 helper（reserved 政策、UI 驗證、PATH-merge、`export` prefix 產生器）在 `src/shared/project-env.ts`。

**Reason**：使用者自己分類（K8s env/Secret、CI vars/masked 的標準模型），比我們猜哪個是機密可靠。單一注入出口讓「之後把 secret 併進來」不用動任何 call site。

## project-env#2 — 全 spawn 面統一注入；dispatcher 是 per-host → env 走 open_session  ·  [Decision]

**Decision**：注入點是 **Shelf 自己組的 spawn 指令**，涵蓋所有 connector：
- **local**（agent-server + terminal pty）：merge 進 spawn 的 `env` Record（`applyEnvMap`，PATH merge、reserved 丟棄），Shelf-required（`ELECTRON_RUN_AS_NODE`）最後套。
- **docker/ssh/wsl**：pty 的 `env` 只到本機 client 不到遠端 shell → 改在遠端指令前綴 `export K='v'; …`（`buildEnvExportPrefix`，PATH 併成 `:"$PATH"`）。這順帶補上了 docker/wsl 一直缺的統一注入點（init script 本來只有 ssh 認）。

**Gotcha（載重）**：dispatcher 是 **per-HOST 共用**的，per-PROJECT env 不能騎它自己的 process env。改由 `open_session` 訊息帶 `env` → dispatcher 存進 ExecEntry → 套到它 spawn 的 per-session exec proc，**且 reconnect 時重套**（否則重連後注入的 env 會掉）。`spawnLocalNode` 的 projectEnv 參數只有 per-tab agent-server 傳；local dispatcher **不**傳（它的 exec 走 open_session 那條）。

## project-env#3 — precedence：靜默覆蓋、PATH merge、SHELF_ 保留字  ·  [Decision]

**Decision**：ambient/繼承 env `<` project env `<` Shelf-required（最後套，backstop）。project env **靜默覆蓋** ambient（生態系慣例：shell `FOO=bar cmd`、docker `-e`、dotenv、CI、K8s 都是覆蓋不警告；在這裡警告只是噪音）。歧義在**輸入時**擋，不在 runtime：
- **PATH 只 merge 不取代**（project 值前置），取代會打斷 binary 查找。PATH 可設但強制 merge、**不**是保留字。
- **plain/secret 同名** → UI inline 擋（跨兩類唯一）。
- **Shelf-required 是保留字**：`SHELF_*` 前綴 + `ELECTRON_RUN_AS_NODE`，單一來源 `SHELF_RESERVED_ENV`（新 `SHELF_*` 自動保留）。UI inline 擋；注入時 Shelf 自己的 var 仍最後套（防手改 config 繞過）。

## project-env#4 — secret at-rest：AES-256-GCM + 可換 key-storage tier seam  ·  [Decision]

**Decision**：secret 值用 `src/main/secret-crypto.ts`（純 AES-256-GCM，versioned + authenticated blob `v1:iv:tag:ct`，錯 key/竄改 fail-loud）加密。master key 的 at-rest 保護是 `src/main/secret-store.ts` 的**可換 seam**，tier 依**實際 runtime backend**選（非平台猜測），三 tier 共用同一 on-disk 格式（tier 可升級、無需資料遷移）：

| tier | 何時 | 保護 |
|---|---|---|
| **os-backed** | Windows DPAPI（user-bound）· Linux 真 keyring（`safeStorage.getSelectedStorageBackend()` ∈ `gnome_libsecret`/`kwallet*`）· **簽章** macOS Keychain（`SHELF_MAC_SIGNED=1`）| 真 OS 級 |
| **local-key** | **unsigned macOS** · **無 keyring 的 Linux**（backend `basic_text`）| per-install 隨機 key 存 0600 檔。擋商品化 infostealer（掃已知明碼 token 樣式）+ 誤上傳雲備份；**非**針對性本機攻擊者 |

**永不** `setUsePlainTextEncryption(true)` / 信任 `basic_text` → 一律退到 local-key，secret 絕不落明碼。storage：單一 project-keyed 檔 `<userData>/project-secrets.json`，per-entry 加密、decrypt scope 只解目標 project 那段（別的 project 的 secret 不進明碼記憶體）；刪 project prune 該段。decrypt 失敗 fail-loud + **跳過該 key**（永不注入 stale/empty），key 留著讓使用者重設。

## project-env#5 — unsigned macOS 必用 local-key，是為 durability 不只避提示  ·  [Gotcha]

**要點**：macOS Keychain ACL 綁 code-signing identity；unsigned build 是 ad-hoc 簽章、cdhash **每次更新都變** → 存進 Keychain 的 key 在 app 更新後**存取不到 → secret 遺失**（不只是每次啟動跳提示）。這是結構性資料遺失，不是 UX 小事。只有 macOS Keychain 綁簽章；Windows DPAPI（user-bound）、Linux keyring（session-bound）unsigned 下仍耐用。所以 mac tier 是**build-time**決定（簽章版 → Keychain；否則 local-key），`SHELF_MAC_SIGNED=1` 只在簽章+公證的 release 才開。

## project-env#6 — 安全靠 key 位置不靠 code obscurity；tier-aware 誠實揭露  ·  [Decision]

**Decision**：不藏 crypto core（不用 private repo / 重混淆）——client app 的 crypto 一定 bundle 在每份安裝的 asar 裡（可反編），private *repo* 只藏原始碼歷史不藏 runtime key path。把 key 留在 readable JS 外的正解是**根本不放那裡** → OS keychain（safeStorage）持 key。crypto core 保持小、標準、**開放**（可審 > 隱晦）。UI 文案講**實際 tier**（os-backed 講 keychain、local-key 講 per-install key + 「app 簽章後升級 keychain」），誠實不誇大、也不嚇人（不用系統級 blocking modal，那會重造 unsigned-app 的不信任）。永久 nuance：值注入到**該 project 所有連線/process**，含互動 terminal（可 `env` 讀到）——文案 surface-agnostic（別列舉「agent + terminal」，加 consumer 不用改字）。

## project-env#7 — secret 不同步靠 side-car + backup allowlist，不靠加密  ·  [Decision]

**要點**：唯一致命外洩是 config-sync 把設定推上 git remote。解法是結構性的：secret 存獨立 side-car（`project-secrets.json`），而 config-backup 用 **allowlist**（只 enumerate 得到的 skill/mcp 能被選+複製），secret 從沒被 enumerate → 天生不可同步（`enumerate.test.ts` 鎖住「只吐 skill/mcp」的 invariant）。加密是正交的另一層——防 at-rest 外洩（誤拷、雲備份、infostealer），不防 sync path。plain env 在 projectConfig（允許同步），secret 永不。
