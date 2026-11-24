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

**診斷規則**：

- 狀態不一致、解析失敗或收到非預期輸入時，沿錯誤處理路徑回報，並記錄定位所需的 ID、原因和不含敏感資訊的上下文。禁止無聲地 `return` 或在 `catch` 後吞掉錯誤。涉及使用者的操作時，畫面須如實呈現結果，例如儲存失敗就顯示資料未儲存。
- 已知且可恢復的良性競態用低層級 log，renderer 可用 `debugLog` 留在 main log。實際資料遺失用 `console.warn` 或 `console.error`。
- 純函式回傳異常，由呼叫端記錄，讓純函式保持可測。樂觀更新和權威狀態對帳不一致時，也要留下診斷資訊。

**Related**：Shelf MCP 啟動失敗的具體套用見 mcp#14。
