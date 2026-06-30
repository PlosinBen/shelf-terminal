---
type: architecture
title: Type-Declared File Transport
related:
  - context/deployment
  - context/connector
  - context/mcp
  - architecture/connection-lifecycle
---

# Type-Declared File Transport

抽象資料流:client 要把一份檔案放到某個 connection 的某處時,**宣告「這是什麼」(a type),不指定「放哪」**。落點由共用規則決定,worker 自己組路徑。MCP 是第一個 consumer;skills / uploads 之後遷移(strangler,見 `features/transport-integration`)。

## 為什麼存在

收斂兩個既有 smell:
1. **per-connection 分流重複** —— ssh/docker/wsl 的傳檔邏輯在 connector(uploads)與 deploy 的 RemoteOps 各寫一份。
2. **client leak remote layout** —— deploy 端硬編 `~/.shelf/apps/<appId>/…` 當推送目標,而 agent-server 又各自 resolve 同一份路徑 → 同一份 layout 知識散在兩處。

## 核心:type-declared placement

```
transport(connection).put({ type, context, source })
  type    宣告「這是什麼」(closed allowlist;e.g. mcp)
  context type-specific 參數(fixed-layout 型別給 appId;cwd-relative 型別給 cwd)
  source  bytes 來源(目前 localPath)
```

落點解析走 **single source of truth**(`@shared/shelf-paths` 的 `shelfPlacement`):`type → { base: 'home'|'cwd', rel }`。**placement 端(transport)與消費端(agent-server 讀檔)共用同一條規則**,不可漂移。`$HOME` 在 **worker 端**解析(connector `homePath()` / shell 展開),client 不碰 remote 的 homedir。

## Authority split(精煉「remote 被動」不變式)

- **client 擁有**:內容 + 語意 `type` + `context`。決定「送什麼、何時送」。
- **worker 擁有**:自己的路徑 layout(由共用規則 + 自身 `$HOME` 組出實體路徑)、以及自身 env 值(`${VAR}` 在此展開,見 `context/mcp` mcp#4)。

仍是「client 決定、remote 被動接收」——只是把「remote 路徑知識」搬回 remote 該在的位置。closed allowlist 是 security gate:未知 type 直接 throw,沒有任意 type→path。

## 分層:byte-mover 與 deploy-plane extras 分開

- **transport.put = 純 byte-mover**:解析落點 → `connector.putFile(absPath, buffer)`。per-connection 分流只剩 connector 一處(`putFile` 在所有 connector 實作,複用既有 `spawnPipeWrite`+`buildRemotePutCmd`,與 `uploadFile` 同一套 proven 機制)。
- **deploy-plane extras 疊在上層,不進 `put`**:hash-gate(skip 無謂重推)、`.heartbeat` lease、`exec` —— 由 caller(如 MCP 的 `syncMcpForConnection` + `deployAgentServer`)負責。避免 `put` 變成吃一堆 flag 的 god-function。

> ⚠️ lease 是上層責任:deploy 必須持 app-dir `.heartbeat`,否則 sweep 回收落點(見 `context/mcp` mcp#6)。

## Do not change casually because

- 別把 hash-gate / heartbeat / exec 折進 `transport.put` —— 分層是刻意的。
- 別讓 client 重新硬編 remote 路徑;落點一律走 `shelfPlacement`,新增 type = 在 `@shared/shelf-paths` 加一筆 + connector 已有的 `putFile` 自動適用。
- 別為 skills+MCP 抽參數化的 config pipeline(`context/mcp` mcp#2);transport 只負責「放 bytes」這一層的共用。

模組落點見 `map`(`connector/transport.ts`、`shared/shelf-paths.ts`、`connector/{各 connector}.putFile`、`connector/file-utils.ts`)。
