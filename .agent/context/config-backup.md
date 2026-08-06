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

> 把本機 app 層 config（Skills + MCP）備份到使用者自己的 git remote，或從一個備份來源複製明確勾選的項目進本機。這是 **backup + cross-machine copy，不是 sync**。git 只在 side-car clone 操作，永不包住 live。Source: `src/main/config-backup/`。

## config-backup#1 — Backup 與 Import 是兩個獨立的 explicit copy 動作  ·  [Decision]

**Decision**：live config 是本機 canonical source。Back up 將勾選項目由 live copy 到自己的 remote branch；Import 將勾選項目由 chosen remote source copy 進 live。沒有背景同步、baseline、conflict resolution 或自動收斂。「Restore」只是 Import 選自己的分支。

兩者位於同一個右側 operation panel 的不同 tab，但狀態與 URL 語意獨立。Import 可以在從未 Back up 的機器上使用；saved Backup URL 只在 Import session 首次開啟時當 transient 預設，Import 編輯值不持久化、也不回寫 Backup settings。

**Do not change casually because**：把 shared default URL 誤解成 binding，會把兩個 explicit copy 動作重新耦合成 sync 心智模型。

## config-backup#2 — 每台機器一個 writable branch；本機 side-car 操作仍需序列化  ·  [Decision]

**Decision**：每台安裝只寫 `backup/<app-instance-id>`，避免多台機器共同寫同一個 ref，也不需要 merge/conflict engine。每次 Backup 先 fetch 並從該 remote branch head materialize，再做 scoped mutation 與 push；若 branch 不存在則從乾淨 base 建立。

Back up 與 Import 雖操作不同 refs，仍共用一個會切換 origin/working state 的本機 side-car clone，因此所有 clone/fetch/materialize/export 工作用 process-local operation lock 序列化。不要以「refs 不同」推論本機 git 操作可無鎖平行。

## config-backup#3 — 系統 git + 機器既有 credentials；設定不做 preflight  ·  [Decision]

**Decision**：用 `simple-git` 薄封裝系統 git，認證沿用 SSH key / credential helper / keychain。Shelf 不解析 remote、不保存 token。Save settings 只落地；缺 git、URL 或認證問題在實際 Back up / Find backups 時 fail-loud。

**Why**：這讓 SSH 與環境既有認證自然可用，也避免 app 自己成為 credential store。不要在 Save 重新引入會被網路或 auth 卡住的 bind/preflight 儀式。

## config-backup#4 — Backup leak gate = valid item 的 explicit opt-in  ·  [Decision]

**Decision**：只有 enumerate 出來、驗證有效且當次勾選的 item 才能離開機器；新項目預設不勾。Skill 在 checklist 階段即檢查 regular directory、無 symlink/特殊檔案、有效 `SKILL.md`，執行時 capture 前後再驗一次，防止 TOCTOU。MCP 以逐 block schema 驗證。

選擇不寫進 tracked exclude list，避免排除項名稱本身洩漏。已 push 的敏感內容仍存在 git history，事後取消勾選不會清 history；真正清除需另做 history rewrite。

## config-backup#5 — Backup selection 是 mutation scope，不是完整快照  ·  [Decision]

**Decision**：每次 Backup 像對 fetched branch head 做 scoped copy：

- selected Skill：remote 同名目錄先整個移除，再 copy captured live Skill；因此 item 內的 remote stale files 會消失。
- selected MCP：只 replace remote keyed object 中的同名 block。
- unselected Skill、MCP 與其他 remote path：保持不動；取消勾選不代表刪除。

`config-backup-intent.json` 只記錄最近一次成功動作的 selected ids，用來預勾下次 checklist；不是 remote inventory，也不產生刪除語意。list 只讀本機 live + intent，不碰網路。

**Do not change casually because**：把 selection 當完整 inventory 會讓只想新增一個備份項目的使用者意外刪除 remote 其他內容。

## config-backup#6 — Import selection 已代表 source-wins whole-item replace  ·  [Decision]

**Decision**：Import checklist 只顯示 `New` / `Replace local` impact，不提供 diff、keep 或逐檔 merge。使用者勾選並按 Import 就表示 canonical item 要成為來源版本：

- Skill：整個目錄替換，所以 source 沒有的 local stale files 會消失。
- MCP：selected server block 替換；未選 local blocks 保留。

全批次先 export、驗證與 prepare，確認所有 selected payload 可用後才改 live。Skill 以 rename/swap 套用，MCP 以 atomic file replace；caught canonical write failure 會反向 rollback 已套用項目，並回傳 phase/item/rollback status。這是 in-process transaction，不保證程序在 swap 中被強制終止時的 crash recovery。成功後 projection/notification 是 best-effort secondary effect，不回滾已成功的 canonical data。

## config-backup#7 — Portable payload scope = Skills + MCP  ·  [Decision]

**Decision**：payload allowlist 只有 Skills 與 MCP servers。settings portable subset 尚未納入；credentials、project paths、project secret env、binding、intent 與 app-instance-id 永遠不進 payload。未知資料不會因位於 `<userData>` 就被順手備份。

**Related**：`context/project-env#7`、`contracts/persistence-formats`。

## config-backup#8 — Operation panel config：Save 是唯一持久化入口  ·  [Decision]

**Decision**：Backup 是 Bottom bar 開啟的右側 operation panel，不屬於 Settings。Back up / Import 是同一 panel 的 tabs；canonical operation 執行時不能切 tab，避免 UI session 與回傳結果錯配。

Back up tab 內的 remote URL + machine label 永遠可 Edit/Cancel/Save；非空 saved URL 才啟用 Back up。Save 純寫檔、兩欄全空等於清除。machine label 預設是 sanitize 過的 hostname，只供來源列表顯示；branch identity 永遠由 app-instance-id 決定。

## config-backup#9 — Import source 必須 pin 到 fetched commit  ·  [Decision]

**Decision**：Find backups 每次 fetch 後，把每個 branch resolved commit 綁成 process-local opaque `sourceRevision`；token 同時綁 remote URL。list items 與 apply 都只接受這個 token，並從 commit isolated export，不能重新以 moving branch ref 讀取。

**Why**：使用者選到的來源在 review/勾選期間必須穩定。遠端 branch 後續前進不能讓按下 Import 時套用另一份內容；切 URL 也不能重用舊 token。token 不持久化，process restart 後重新 Find backups 即可。

## config-backup#10 — Skill control markers 是 destination-local state  ·  [Decision]

**Decision**：`.locked` / `.disabled` 不屬於 portable Skill payload。Back up capture 排除它們；Import 忽略 source markers，替換既有 Skill 時保留 destination markers，新 Skill 則不憑空建立 markers。

**Why**：lock/disabled 表達這台 app installation 的操作與 mount 狀態，不是 Skill 內容；跨機器複製它們會讓來源機器的控制狀態意外接管目的機器。
