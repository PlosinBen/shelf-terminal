---
type: architecture
title: Config Backup & Copy flow
related:
  - context/config-backup
  - architecture/skills-projection
  - architecture/mcp-sync
---

# Config Backup & Copy flow

把 app 層 config（Skills + MCP）備份到使用者的 git remote，或從任一備份分支把明確勾選的項目複製進本機。這是 **backup + copy，不是 sync**：兩個動作各自有來源、目的與選取範圍，沒有背景收斂或雙向 baseline。

## Building blocks

- **Live config**：本機 canonical Skills 資料夾與 MCP keyed object；Backup 只讀，Import 才會明確寫入。
- **Operation panel**：同一個右側 sidebar panel 內有 Back up / Import tabs。renderer store 持有 panel session、草稿、選取與 request token；UI 只 emit intent，中央 handler 才打 IPC。
- **Side-car repo**：`<userData>` 下的共用 git clone。git 只在這裡操作，不包住 live；Backup 與 Import 的 git 工作由同一把 process-local lock 序列化。
- **Remote**：使用者自己的 git remote，每台機器寫一個 `backup/<app-instance-id>` 分支。
- **Machine-local state**：saved Backup URL/label、Backup intent、app instance id 與 Skill control markers 都不是 portable payload。

## Backup（Publish）— selected live items → my branch

```text
開 panel（只列 live + 讀本機 intent，不碰網路）
  → 勾選有效項目 → 先 capture + 重驗整份 selected payload
  → lock → ensure clone + fetch → materialize 我的 remote head
  → 每個 selected Skill：rm remote item dir，再 cp captured whole dir
  → 每個 selected MCP：只 replace 同名 remote block
  → stage selected paths + machine manifest → commit/push（有異動才 push）
```

- 勾選代表本次 mutation scope，不代表 remote 完整 inventory；**未勾選的 remote Skill/MCP/其他路徑不動**。
- 同一個 selected Skill 以資料夾為單位 source-wins，所以該 Skill 遠端既有但本機已移除的舊檔會消失。
- selected MCP 只替換同名 block；未選 MCP 保留。只有選到 MCP 時才需要解析既有 remote MCP 檔。
- 空選取、symlink、特殊檔案、無效 `SKILL.md` 或 capture 中途改變都在接觸 remote 前 fail-loud。
- `.locked` / `.disabled` 不進 payload。成功後才保存 intent；新出現項目預設不勾。

## Import（Copy）— pinned source items → live

```text
輸入 transient Import URL（首次可用 saved Backup URL 當預設，但不儲存）
  → lock + fetch branches → 每個來源綁定 opaque revision token / commit
  → 選來源 → isolated export pinned commit → 驗證並列 New / Replace local
  → 勾選項目 → isolated export 同一 pinned commit
  → prepare 全批次（驗證、保留 destination control markers、計算 canonical bytes）
  → commit：selected Skill whole-dir swap + selected MCP block replace
  → caught failure 反向 rollback 已套用項目
  → 成功後 best-effort Skills/MCP projection notification
```

- Import URL 與 Backup 設定獨立；沒有 Backup binding 也能 Import。來源選自己的分支就是 Restore。
- UI 不提供 diff、keep 或「建立 vs 覆蓋」決策；勾選 Import 已表示要把該 item 變成來源版本。impact 只用於告知 New / Replace local。
- selected Skill 是 whole-item source-wins；local-only 舊檔會消失。destination `.locked` / `.disabled` 保留，source markers 忽略。
- selected MCP block source-wins，未選 local MCP 保留；canonical MCP 檔採 atomic replace。
- 全批次先 prepare 才改 canonical live。process 仍存活且 write failure 被捕捉時會 rollback；程序在 swap 中被強制終止不在此保證內。
- pinned token 是 process-local、綁 remote URL 與 fetched commit；遠端分支之後前進不會偷偷改變已選來源。

## Independence and serialization

產品語意上 Back up 與 Import 是獨立 copy 動作：一個 URL 不會把另一個動作變成 sync，也不共享選取或儲存 Import URL。實作上兩者仍共用會切換 origin/working state 的 side-car，因此所有 git/materialization 工作必須序列化；Import 用 isolated export，避免把 side-car working tree/index 當長期 source view。
