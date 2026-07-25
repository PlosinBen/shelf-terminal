---
type: context
title: App-Level Config Backup & Copy
related:
  - context/skills
  - context/mcp
  - context/deployment
  - architecture/config-backup
  - contracts/persistence-formats
---

# App-Level Config Backup & Copy

> 把這台機器的 app 層 config（skills + MCP）備份到使用者自己的 git remote，並能從別台機器的備份「複製」進本機。這是 **backup + cross-machine copy，不是 sync**。git 只當 transport/store，跑在一個 side-car clone 上，永不包住 live 資料夾。Source: `src/main/config-backup/`。

## config-backup#1 — Backup + Copy, NOT sync（鐵律 + 兩個動作）  ·  [Decision]

**Background**：需求是「skills / MCP 跨機器可用、綁 GitHub」。直覺會做成雙向 sync，但 sync 需要 baseline + conflict engine + delete 傳播，複雜且危險。

**Decision**：定位成 **備份 + 複製**，只有兩個動作。**鐵律：一台機器的 live config 是它唯一的真相源，任何動作都不會自動覆蓋它（現況為主）。**
- **Backup（Publish）**：把勾選的 live 項目快照 → 我自己的 remote 分支。單向（live → my branch），**永不碰 live**。
- **Import（Copy）**：瀏覽某個備份分支（別台的，或我自己的），挑項目複製進 live。**Import 是 live 的唯一寫入者**，per-item、覆蓋前 diff 確認。

「Restore（還原）」不是第三個動作 —— 就是 **Import，來源選我自己的分支**，同一條 code path。

**Do not change casually because**：叫它「sync」會誤設期待（這裡沒有 delete 傳播、沒有自動收斂、機器不會變一致）。Backup 天生安全（碰不到任何 live），Import 是唯一寫 live 的所以永遠 manual + 覆蓋確認 —— 這個不對稱是設計核心。

**Related**：`architecture/config-backup`、`config-backup#2`。

## config-backup#2 — 每台機器一個分支 → 沒有 conflict engine  ·  [Decision]

**Background**：sync 的複雜度幾乎全來自「多方寫同一個 ref」。

**Decision**：**每台機器只寫自己的 `backup/<app-instance-id>` 分支**（ref 由穩定的 `app-instance-id` 決定，見 `contracts/persistence-formats`）。因為只有本機寫自己的分支，**每次 push 都是 fast-forward** —— 不用 pull-first、沒有 non-fast-forward、沒有 merge、沒有 3-way、沒有 baseline。Import 對來源分支是**唯讀 fetch**，零競爭。唯一殘留的互動是 Import 的**覆蓋確認**（為守鐵律，不是解 conflict）。

**Do not change casually because**：整個「push/pull 解耦、無 conflict engine」都靠 per-machine branch 這個前提。若改成共享分支，所有被消掉的 sync 複雜度會全部回來。

**Related**：`config-backup#1`、`config-backup#5`（快照語意）。

## config-backup#3 — git engine = 系統 git（simple-git）；auth = 機器自己的 git 憑證  ·  [Decision]

**Background**：side-car 需要 git 能力（clone/fetch/commit/push/diff）。選項：自帶 isomorphic-git，或用機器的系統 git。

**Decision**：**引擎 = 系統 git（`simple-git` 薄封裝）；認證 = 機器既有的 git 憑證（SSH key / credential helper / keychain），跟使用者平常 `git push` 一樣。Shelf 不存任何 token、不碰 secret** → 零認證洩漏面。**不做任何預檢**：`git`（local）或 remote（GitHub…）真的丟錯,才在 `runBackup` 的 try/catch 原樣攤回 UI（reason `remote` + git stderr）。

**Do not change casually because**：不選 isomorphic-git 是因為它**沒有 SSH、也不讀環境的 credential helper / keychain**，會逼 Shelf 自己保管 PAT。既然 auth 是使用者責任，沿用環境 git 最簡也最安全，而「沿用環境憑證」只有系統 git 辦得到。代價是硬依賴機器有裝 git（缺 git 就是 git spawn 失敗,同樣走 try/catch 攤回,不另外 preflight）。`simple-git` 打包進 main bundle（rollup），不是 external。

**Related**：`src/main/config-backup/side-car.ts`、`config-backup#8`。

## config-backup#4 — Leak gate = Backup per-item opt-in；不寫 committed .gitignore  ·  [Decision]

**Background**：備份會把內容送上 remote，機密 skill / 帶 literal token 的 MCP 不該外流。

**Decision**：**洩漏防線 = Backup 的 per-item 勾選**。沒勾的項目根本不離開機器；新的/沒備份過的項目**預設不勾**（忘記＝留在本機）。選擇用「複製了什麼」表達，**不序列化成任何 tracked 檔案**（committed 的 exclude-list 本身就會洩漏被排除的名字，所以不碰 `.gitignore`）。MCP 偏好 `${VAR}` 而非 literal token，備份就不帶 secret（`context/mcp` mcp#4）。

**Do not change casually because**：**History caveat** —— 一旦某項 push 過就留在分支歷史裡，之後取消勾選只擋未來、無法回收過去；真正移除要 reset/rewrite 自己的分支。所以「預防（別勾）」才是真防線，不是事後排除。

**Related**：`config-backup#1`、`context/mcp` mcp#4。

## config-backup#5 — Backup 是「勾選集的完整快照」→ checklist 預勾靠本機 intent  ·  [Gotcha]

**Background**：Backup 每次把 payload 區清空再依勾選重寫（`git add -A` 會 stage 刪除），所以分支永遠等於「我最新發佈的那一份」。

**Gotcha**：因為是完整快照，**取消勾選會在下次 Backup 時把該項從分支移除**。若 checklist 預設全不勾，使用者只勾一個新 skill 就會**清掉整個備份** → 資料遺失。所以 checklist 要**預勾我上次備份的項目**，新項目才預設不勾（＝leak gate）。

**預勾來源 = 本機 intent，不是 remote**：預勾集存在 `<userData>/config-backup-intent.json`（`intent-store.ts`），是「我這台機器選了要備份什麼」的 prefs——只在 `runBackup` 成功時覆寫，其餘一律不動（改／清 remote 都不波及）。開 checklist（`config-backup:list`）**只讀本機 intent，完全不碰 git／網路**，所以秒開、離線一樣正常。remote 只在**按下 Back up 當下**（`runBackup` 的 git ops）才碰。

**Do not change casually because**：「備份意圖」是本機的選擇，刻意跟 remote 狀態解耦——不要為了預勾而回去讀分支（那會逼 `list` 每次同步等一次 `git fetch`，就是先前每次進頁面都 loading 的原因）。取捨：重裝／清掉 userData 後 intent 遺失 → 首次進來全不勾（使用者重選即可），換來的是「意圖即本機 prefs、單向不依賴 remote」這條乾淨模型。intent 跟 binding 一樣**永不進備份 payload**。

**Related**：`config-backup#2`、`config-backup#4`、`src/main/config-backup/intent-store.ts`。

## config-backup#6 — Import 覆蓋處理：new/identical/differs，永不刪 live  ·  [Decision]

**Background**：Import 把備份項目寫進 live，但 live 可能已有同名項目。

**Decision**：以「你已經有這個；這是差異；replace 或 keep」的心智模型，per-item 逐檔比對：
- **skill = folder → by file**：backup 每個檔 → live 不存在則複製（additive，永遠複製）、相同則跳過、不同則顯示 diff（左 live / 右 backup）+ 確認 replace/keep（**傾向 replace**）。**backup 沒有的 live 檔一律不動 —— Import 從不刪除**（no-orphan `skills#8`）。
- **MCP = per-server merge**：只加/換該 server 的 block，不整檔覆蓋。
- Apply 走正常 `onSkillsChanged()` / `onMcpChanged()` re-projection pipeline，不是純寫檔。
- **「Replace all existing」bulk checkbox**（Import 限定、預設 OFF、per-session）：跳過逐項 diff 直接覆蓋所有勾選項。它**繞過覆蓋保護**，所以預設關、每次明確選、不持久化；風險是覆蓋本機版本（資料遺失），不是洩漏（洩漏只在 Backup/egress 端）。

**Do not change casually because**：no-orphan（永不刪 live 檔）是硬不變式。skill 檔用 `git checkout <ref> -- <path>` 落到 side-car working tree 再 fs-copy bytes（binary-safe），不要走 `git show` 字串（會壞二進位 aux 檔）。

**Related**：`skills#8`、`context/mcp`、`src/main/config-backup/import.ts`。

## config-backup#7 — v1 scope = skills + MCP；settings 延後  ·  [Decision]

**Decision**：v1 的 payload 只有 **skills + MCP servers**。`settings.json` 的 portable subset **刻意延後** —— 需要逐 key 的可攜性審計（哪些 key 跨機器有意義、未知 key 預設 OUT，且不能帶 `logLevel` / telegram token / `pmActive` 之類機器本地 key）。credentials（`~/.claude`）、`projects.json`（本地路徑）、`app-instance-id`（每機唯一）永遠不入 payload。

**專案 secret env**（`project-secrets.json`）也**永不入 payload**：backup 用 allowlist（只 enumerate 得到的 skill/mcp 能被選+複製），secret 從沒被 enumerate → 天生不可同步（`enumerate.test.ts` 鎖住此 invariant）。詳見 `context/project-env#7`。

**Related**：`contracts/persistence-formats`（config-backup.json + branch payload layout）、`context/project-env#7`（secret side-car 不同步）。

## config-backup#8 — 沒有 binding 儀式：設定歸設定、backup 歸 backup  ·  [Decision]

**Background**：早期把「設定 remote」做成綁定/解綁的儀式（未綁 → bind 表單；已綁 → 只剩摘要 + Unbind）。結果 remote URL/label 綁了就改不了（只能 Unbind 重來），且 bind 前的 preflight 讓「設定」這件事卡在網路驗證上。

**Decision**：Backup tab 是**單一頁面**、兩個獨立區塊：
- **Remote 設定**（remoteUrl + machineLabel）永遠可編輯，**唯一持久化入口 = Save**（`config-backup:save-settings`）。Save **純寫檔、零驗證**（`saveBinding` verbatim）；**兩欄全空 = 清除**（刪掉 `config-backup.json`）。
- **Back up / Import** 永遠顯示。**完全不預檢**：按 Back up 才跑 git，`git`/remote 真的丟錯就地攤成 `backup-status-err`（`config-backup#3`）。沒設 remoteUrl → `runBackup` 回 `not-bound`。
- **machineLabel 預設 = sanitize 過的 hostname**（`sanitizeMachineLabel`：`[^A-Za-z0-9._-]→-`，**不去網域尾碼**；main 端 `os.hostname()` 算好經 `list().suggestedLabel` 給 renderer 當可編輯預設值）。label 只是顯示名，**不決定分支**（分支＝app-instance-id，`config-backup#2`）。

**Do not change casually because**：「設定歸設定、backup 歸 backup」是刻意的——設定只是設定，錯誤延到動作當下才報，不要重新引入 bind 儀式或 Save 前 preflight（那正是先前 URL 改不了、設定卡網路的來源）。Save 是唯一寫入點：不要加會立刻動 config 的旁路動作（例如即時 Clear），會破壞「改草稿 → Save 才落地」的一致性——清除就是清空兩欄再 Save。intent 與此解耦（`config-backup#5`）。

**Related**：`config-backup#3`、`config-backup#5`、`contracts/ipc-channels`、`src/renderer/components/settings/BackupSettingsTab.tsx`。
