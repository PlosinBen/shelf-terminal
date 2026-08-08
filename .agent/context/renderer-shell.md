---
type: context
title: Renderer Right Panel Shell
related:
  - context/config-backup
  - context/mcp
  - context/pm-agent
---

# Renderer Right Panel Shell

## renderer-shell#1 — 右側 panels 共用單一 shell 與 width policy  ·  [Decision]

**Decision:** PM、Notes、Skills、MCP、Backup 與 Dev Tools 都以 `RightPanel` 作為外框。Shell 固定使用 `<aside>` root，負責 resize handle、header wrapper、component-local width state 與 drag cleanup；feature panel 只提供穩定 root class、accessible label、header 內容、body 及自己的 domain lifecycle。

Width policy 的單一來源是與 shell 同檔 export 的 `RIGHT_PANEL_WIDTH`：共用 range 是 `280–700`，defaults 為 MCP `440`、Notes `380`、PM `380`、Skills `480`、Dev Tools `320`、Backup `400`。Panel 關閉會 unmount，再開時回到 default；width 不寫 renderer store 或 settings。

**Reason:** 外框、resize 與 width literals 分散在各 panel 會產生行為漂移，也容易讓新 panel 漏掉 resize。共用 shell 讓六個 panel 使用同一套邊界與 cleanup，但不強迫形狀不同的 title、Back、close 或 toggles 共用 API。

**Do not change casually because:** 不要把 width literals 或 resize listeners 放回 feature panels，也不要在沒有新產品需求時將 width 持久化；這些都會重新引入多份 policy 或改變關閉即重設的 lifecycle。

### Gotchas

- Drag cleanup 必須在 mouseup、window blur 與 unmount 共用同一條 idempotent path，並還原拖曳前的 `body.cursor` / `body.userSelect`，不能假設原值為空字串。

## renderer-shell#2 — Resize 以被拖曳 panel 的起始寬度計算  ·  [Gotcha]

**Symptom:** 多個右側 panel 並排時，拖曳左邊 panel 會突然變得過寬或直接撞到 max width。

**Root cause:** `window.innerWidth - clientX` 只在被拖曳 panel 的右緣等於 viewport 右緣時成立；右邊還有 sibling panel 時，公式會把 sibling 的寬度也算進目標 panel。

**Fix / note:** `mousedown` 記錄 `startWidth` 與 `startX`，`mousemove` 使用 `startWidth + (startX - clientX)` 後再 clamp 到共用 range。
