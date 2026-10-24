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

抽象資料流:client 要把一份檔案放到某個 connection 的某處時,**宣告「這是什麼」(a type),不指定「放哪」**。落點由共用規則決定,worker 自己組路徑。Consumers:MCP config、app-level skills 樹、user uploads —— 全部走同一條 byte-mover。

## 為什麼存在

小型 control data 與大型 runtime payload 有不同的來源契約，但 transport-specific 執行都由 connector 擁有：

- 小型 config、skills 與 upload 走型別宣告的 placement，再由 connector 寫入 bytes。
- 大型 runtime payload 以本機檔案路徑交給 connector 的原生檔案複製操作，不必在 app process 中讀成整份 Buffer。
- Deploy 編排選擇內容、順序與 completion marker，不直接啟動另一套 transport。

## 核心:type-declared placement

```
transport(connection).put({ type, context, source })          // 單檔
  type    宣告「這是什麼」(closed allowlist;mcp / skill / upload)
  context type-specific 參數(fixed-layout 給 appId;cwd-relative 給 cwd + name)
  source  bytes 來源:{ localPath } 或 { buffer }(uploads 從 renderer 來是 buffer)

transportPutDir(connection, { type, context, files })          // 多檔(一棵樹)
  files   Array<{ rel, localPath }> —— rel = type dir 底下的相對路徑
```

落點解析走 **single source of truth**(`@shared/shelf-paths` 的 `shelfPlacement`):`type → { base: 'home'|'cwd', rel }`。**placement 端(transport)與消費端(agent-server 讀檔)共用同一條規則**,不可漂移。`$HOME` 在 **worker 端**解析(connector `homePath()` / shell 展開),client 不碰 remote 的 homedir。

**`transportPutDir`(多檔)**:skills 是一棵樹。它**解析 home 一次**(一個 `homePath()` round-trip),再對每個檔 `putFile`;**caller 傳已過濾的清單**(skills 端先 `listSkillFilesRel` 濾掉 `.locked`)—— transport 不走訪 source tree,type-specific 過濾留在 caller。沒做 tar 打包(YAGNI;檔少,per-file `putFile` 即可)。

**Placements**(每個 type 一筆 const + 一個 builder):`mcp` → `home:.shelf/apps/<appId>/mcp-servers.json`;`skill` → `home:.shelf/apps/<appId>/skills`(dir);`upload` → `cwd:.tmp/shelf/<name>`(`name` = caller 算好的 prefix+sanitise leaf,所以 shelf-paths 維持純函式)。`.tmp/shelf` 的 layout 常數(`SHELF_UPLOAD_DIR_REL`)是單一來源,`connector/file-utils` 的 list/size/clear 也從它 derive。

## Authority split(精煉「remote 被動」不變式)

- **client 擁有**:內容 + 語意 `type` + `context`。決定「送什麼、何時送」。
- **worker 擁有**:自己的路徑 layout(由共用規則 + 自身 `$HOME` 組出實體路徑)、以及自身 env 值(`${VAR}` 在此展開,見 `context/mcp` mcp#4)。

仍是「client 決定、remote 被動接收」——只是把「remote 路徑知識」搬回 remote 該在的位置。closed allowlist 是 security gate:未知 type 直接 throw,沒有任意 type→path。

## 分層:byte-mover 與 deploy-plane extras 分開

- **transport.put = 純 byte-mover**:解析落點 → `connector.putFile(absPath, buffer)`。per-connection 分流只剩 connector 一處(`putFile` 在所有 connector 實作,複用 `spawnPipeWrite`+`buildRemotePutCmd`)。**buffer byte-write 的 primitive 是 `putFile`** —— `uploadFile` 也疊在它上面(見下),不再有第二套 upload-write 堆疊。
- **upload policy 疊在 `putFile` 上,不進 byte-mover**:`uploadFile` = gitignore guard(non-clobber `.tmp/.gitignore`;local 走 fs、remote 走 shell —— 唯一殘留的平台差異)+ `putFile`。guard 沒法進「內容無關」的 byte-mover,所以是 caller 一步(remote 多一次 exec round-trip,互動 paste 路徑可接受)。共用 `remoteUploadFile`(3 個 remote connector)。
- **deploy-plane extras 疊在上層,不進 `put`**:hash-gate(skip 無謂重推)、`.heartbeat` lease、`exec` —— 由 caller(MCP 的 `syncMcpForConnection`、skills 的 `syncSkillsToRemote`、`deployAgentServer`)負責。避免 `put` 變成吃一堆 flag 的 god-function。
- **大型 runtime transfer 也由 connector 擁有**：deploy 傳入 local file path 與 target path，connector 選擇原生搬運方式。這個操作與小型投影的 Buffer byte-write 分開；manifest、parent creation、mode、completion marker 與 lease 仍是上層責任。

> ⚠️ lease 是上層責任:deploy 必須持 app-dir `.heartbeat`,否則 sweep 回收落點(見 `context/mcp` mcp#6)。

## Do not change casually because

- 別把 hash-gate / heartbeat / exec / gitignore guard 折進 `transport.put` / `putFile` —— 分層是刻意的。
- 別讓 client 重新硬編 remote 路徑;落點一律走 `shelfPlacement`,新增 type = 在 `@shared/shelf-paths` 加一筆 + connector 已有的 `putFile` 自動適用。
- 別把 `uploadFile` 改回自帶 write command(`buildRemoteUploadCmd` 已刪)—— 它必須疊在 `putFile` 上,否則又長出第二套 per-connection byte-write 堆疊。
- 別因共用 connector 就強制大型 runtime payload 讀成 Buffer；變更搬運方式前，先量測代表性 payload 的記憶體與傳輸表現。
- 別為 skills+MCP 抽參數化的 config pipeline(`context/mcp` mcp#2);transport 只負責「放 bytes」這一層的共用。

模組落點見 `map`(`connector/transport.ts` 的 `transportPut`/`transportPutDir`、`shared/shelf-paths.ts` 的 placement table、`connector/{各 connector}.putFile`、`connector/file-utils.ts` 的 `remoteUploadFile`/`buildGitignoreGuardCmd`)。skills sync 在 `agent/remote.ts` 的 `syncSkillsToRemote`(absolute-home gotcha 見 `context/connector` connector#6)。
