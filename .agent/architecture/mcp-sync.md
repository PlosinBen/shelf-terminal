---
type: architecture
title: MCP Config Sync
related:
  - context/mcp
  - architecture/skills-projection
  - architecture/transport
---

# MCP Config Sync

App-level MCP config 從 UI 編輯到 provider 載入的抽象資料流。**sibling of skills projection**(`architecture/skills-projection`)但獨立管線——細節與「為什麼」見 `context/mcp`(mcp#2/#4/#5)。

```
manager UI ─┐
agent bridge┴→ MCP config store ─→ onMcpChanged()   ← sibling, NOT onSkillsChanged()
                                      │
        ┌─────────────────────────────┼──────────────────────────────┐
        ▼                             ▼                              ▼
  projectMcpLocal              subscribers(注入)              MCP_CHANGED
  寫單一 mcp-servers.json        ① remote re-mirror VIA transport      → 設定 UI refetch
  + touch .heartbeat            ② 每個 live session emit
  (local 消費路徑)               "reconnect to apply" 通知(無 reload)

next session create:
  agent-server 讀 + 解析 projected mcp-servers.json
    → 對 worker env 展開 ${VAR}  → (Claude) merge 進 shelf bridge
    → SDK mcpServers  → spawn stdio / connect http   ── 跑在 worker
```

## 關鍵差異(對照 skills projection)

- **內容是單一 JSON,不是樹**:`projectMcpLocal` 寫一份 `mcp-servers.json`;遠端走 type-declared transport(`architecture/transport`),不是複製 RemoteOps。
- **消費方式不同**:skills 樹由 SDK 自動掃;MCP config 是 create-time SDK **參數** → agent-server 必須**讀+解析**再餵(`context/mcp` mcp#4)。
- **無 hot-reload**:skills 的 reload 步驟換成 reconnect 通知(`context/mcp` mcp#5)。
- **兩個 sync 觸發點**:connect-time(`deployAgentServer` 內,鏈路已建、reuse ssh ControlMaster)讓 fresh remote session 載到;edit-time(`subscribeMcpChanged` subscriber)re-mirror 到 live remotes。client-side in-memory hash-gate 跳過無謂重推。

模組落點見 `map`(`mcp-sync.ts` / `mcp-projection.ts` / `mcp-remote.ts` / `agent-server/providers/mcp-config.ts`)。
