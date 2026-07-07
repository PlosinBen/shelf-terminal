---
type: architecture
title: Config Backup & Copy flow
related:
  - context/config-backup
  - architecture/skills-projection
  - architecture/mcp-sync
---

# Config Backup & Copy flow

抽象資料流：把 app 層 config（skills + MCP）備份到使用者的 git remote，並能從別台機器的備份複製進本機。**backup + copy，不是 sync**（見 `context/config-backup`）。

## Building blocks

- **Live config**：本機的真相源（skills 資料夾 + MCP 設定）。永遠不是 git repo，任何動作都不會自動覆蓋它。
- **Side-car repo**：`<userData>` 下一個獨立的 git clone，git **只**在這裡操作，永不包住 live。Backup/Import 是 live 與 side-car working tree 之間的檔案複製。
- **Remote**：使用者自己的 git remote，每台機器一個 `backup/<app-instance-id>` 分支。
- **Binding**：本機專屬設定（remote URL + 機器 label），機器本地、永不進 payload。
- **Preflight**：綁定/Backup 前的 fail-loud 檢查（git 在不在、remote 認不認得過）。

## Backup（Publish）— live → my branch，單向

```
勾選 live 項目 → preflight → ensureClone + fetch → checkout 我的分支
  → 把 payload 區清空、依勾選重寫（skills 整包 copy、MCP 濾成勾選的 server）+ machine манifest
  → commit → push 我的分支（永遠 fast-forward）
```

- 每次 Backup 寫「勾選集的**完整快照**」：取消勾選 = 該項從分支移除（`git add -A` stage 刪除）。
- 只有本機寫自己的分支 → 無 merge / 無 conflict。
- 沒勾的項目永不離開機器（leak gate）。checklist 預勾「分支裡已有的項目」以免快照語意誤刪。

## Import（Copy）— chosen branch → live，唯一寫 live 者

```
列出所有備份分支（含自己）→ 選一個來源分支
  → 讀該分支的項目清單（唯讀）→ 勾選要複製的
  → plan：逐檔/逐 server 比 live（new / identical / differs）
  → differs 顯示 diff + 確認 replace/keep
  → apply：new 一律複製、identical 跳過、differs 依決定覆蓋；永不刪 live 檔（no-orphan）
  → 走 skills / MCP 的 re-projection pipeline（見 architecture/skills-projection、mcp-sync）
```

- 對來源分支唯讀 fetch，零競爭。
- 「Restore」= Import 來源選自己的分支，同一條路。
- Bulk「replace all existing」（預設 OFF、per-session）跳過逐項 diff 直接覆蓋。

## 為什麼 push/pull 解耦

Backup 寫**我的**分支、Import 讀**別人的**分支 —— 作用在不同 ref，所以兩個動作天然獨立、互不阻塞，也不需要任何 baseline / linear-mirror 紀律。這是 per-machine branch 帶來的核心簡化。
