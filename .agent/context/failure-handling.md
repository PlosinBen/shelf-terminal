---
type: context
title: Failure Handling
related:
  - context/mcp
  - context/agent-observability
---

# Failure Handling

## failure-handling#1 — 可用性可降級，安全與資料正確性條件不可放寬  ·  [Decision]

**Decision**：依賴失敗時，停止依賴該能力的操作，保留能獨立且安全運作的功能，
並明確呈現受影響範圍與原因。不得為維持可用性而繞過認證／授權、跳過必要驗證、
靜默丟失資料，或把失敗呈現為成功。這是跨功能的設計與 review 約束，不限定 MCP。

**Reason**：非必要能力故障不應擴大成整個 App 不可用，但繼續運作不能犧牲安全
或製造錯誤的成功狀態。能否局部降級取決於真實依賴，不是 blanket catch 後繼續。

**Do not change casually because**：安全性或資料正確性的必要條件無法成立時，
受影響操作必須停止。狀態未知不能當成成功；訊息傳送失敗不能標示已送達，
持久化失敗不能標示已儲存。可恢復性不等於可忽略錯誤，須留可診斷且不含 secret
的資訊。對外部不合法請求只拒絕該請求，不應直接停用仍正常的服務，避免把拒絕
機制變成拒絕服務入口。此原則不代表所有子系統都已有自動恢復或健康監測。

**Related**：Shelf MCP 啟動失敗的具體套用見 mcp#14。
