---
type: context
title: App-Level MCP Servers
related:
  - context/skills
  - context/deployment
  - architecture/mcp-sync
  - architecture/transport
  - contracts/persistence-formats
---

# App-Level MCP Servers

> User-provided external MCP servers, set once at the app level → loaded by both providers, across every project, running on the worker. Sister to app-level skills (`skills`). Config → projection/transport → agent-server feeds the SDK's `mcpServers`.

## mcp#1 — App-level MCP is ADDITIVE on top of native, not a replacement  ·  [Decision]

**Background**：要使用者「設一次 MCP server → 所有 project、兩個 agent、跑在 worker」。三個 MCP 來源並存:① agent 的**原生** MCP(帳號 connector、project `.mcp.json`…)、② in-process `shelf` bridge、③ 本 feature 的 app-user servers。

**Decision**：app-level MCP **疊加**在原生之上,**不排除原生**。① 由 SDK 自己載入(Claude 刻意不設 `settingSources` → native parity with raw CLI,見 PRODUCT.md #5 與 `CLAUDE_QUERY_DEFAULTS` 註解;Copilot 走 `enableConfigDiscovery`)。心智模型:**native = 這台機器/帳號本來就有的(per-machine);app-level = 你要「到處都有」的(Shelf 管,跨 project/provider/worker)**。只有 app level,無 per-project MCP 層。

**Do not change casually because**：**不要**為了「乾淨」去擋原生 MCP —— 唯一的擋法 `settingSources: []` 會**連帶把 native skills / CLAUDE.md 一起關掉**(`skills#1` 那條也靠 settingSources-omitted),且違背 PRODUCT.md #5。`/mcp` 同時列出 native + `shelf` + app-user 是**正確**的。

**Related**：`skills#1`、`agent-providers`、PRODUCT.md #5、`agent-server/providers/{claude,copilot}/index.ts`。

## mcp#2 — Sibling `onMcpChanged()` pipeline — NOT a call into `onSkillsChanged()`  ·  [Decision]

**Background**：MCP 鏡射 skills 的 file projection(`skills#1`)與 mutation/sync 形狀(`skills#2` Decision C),但屬於**不同內容域**。

**Decision**：MCP 有自己的 `onMcpChanged()`(`mcp-sync.ts`),**不得呼叫** skills pipeline。流程:單一 writer(`mcp-store`)→ `onMcpChanged()` → ① `projectMcpLocal`(寫單一 `mcp-servers.json` + touch `.heartbeat`)② subscribers(remote re-mirror,由 `agent/index.ts` 經 `subscribeMcpChanged` 反向注入,避 import cycle)③ `MCP_CHANGED` 通知 renderer。遠端鏡射走 **transport**(`architecture/transport`),不是複製 RemoteOps。

**Do not change casually because**：把 MCP fold 進 `onSkillsChanged()` 會重投影 skill 樹、觸發 skill hot-reload、在無關 agent tab 冒出 `skills#9` 的 "Skills reloaded" —— 正是 `skills#2` Decision C / `skills#9` 在守的 cross-talk。也**別**把 skills+MCP 抽成參數化 `onConfigChanged()`(只兩個 instance,過早抽象;等第三種 app-level config 再說)。

**Related**：`skills#2`、`skills#9`、`architecture/mcp-sync`、`src/main/{mcp-sync,mcp-projection,mcp-remote}.ts`、`src/main/agent/index.ts`。

## mcp#3 — Config schema = keyed object; stored OPAQUE (secret/auth out of scope)  ·  [Decision]

**Background**：`mcp-servers.json` 的格式與「裡面可能有 token」的處置。

**Decision**：
- **Keyed object** `{ "<name>": <block> }`(**非** array、**不**包 `mcpServers` wrapper)。理由:每個 `<block>` value 可從 MCP 生態 config 直接貼上、1:1 對映 SDK `mcpServers` record、name 唯一性結構性保證;拿掉 wrapper 是要表明「這是 Shelf 自己的 map,不是 drop-in 原生檔」。`<block>` = `{type:'stdio',command,args?,env?}` | `{type:'http',url,headers?}`(name 在 key)。
- **Opaque 儲存,不代管 secret**:`env`/`headers` 可能含 token,但比照 project init-script(`projects.json` 明文 `export API_KEY=…`)—— **無 secret store、無加密、不禁字面值**。「存可能含 secret 的欄位」不算代管,只有 *egress* 才是。建議(非強制)用 `${VAR}` 引用而非字面值,讓同步檔可攜。secret 治理全在 config-sync 的 egress 邊界,不在本 feature。

**Do not change casually because**：別加 secret store / 別改 array 格式 / 別包 `mcpServers` wrapper(會像 drop-in 原生檔,造成 mcp#1 的混淆)。validator 在 `@shared/mcp`(`validateMcpEntry`),main store 與 agent-server loader 共用(後者不能 pull electron)。

**Related**：`features/config-sync`(egress)、`contracts/persistence-formats`、`src/shared/mcp.ts`、`src/main/mcp-store.ts`。

## mcp#4 — Consumption: agent-server reads+parses → feeds SDK param (not SDK-auto-read)  ·  [Decision]

**Background**：skills 的投影樹是 SDK **自己讀**;MCP 的 `mcpServers` 是 **create-time SDK 參數**(in-memory object,兩家都是)—— SDK 不讀檔。

**Decision**：agent-server 在 session-create **讀 + 解析** projected `~/.shelf/apps/<appId>/mcp-servers.json` → 組 `mcpServers`(`agent-server/providers/mcp-config.ts` `loadProjectedMcpServers`)。
- **`${VAR}` 只在這裡 materialize**:agent-server 在 worker 上對 **worker process env** 展開 → transient、in-memory、Shelf 不落地(呼應 mcp#3 的不代管)。
- **Fail-loud(記取 `skills#6`)**:壞 JSON / `${VAR}` 缺 env / server 起不來 → **surface,不 silent-skip**。解析錯在讀檔步驟報(`serverLog('warn',…)`);起不來靠 SDK 回報 failed 狀態。
- **Claude bridge merge**:`shelf` bridge 是 sdk-type MCP server,跟 user servers 同在 `options.mcpServers` → merge,`shelf` 放**最後**讓使用者命名的 "shelf" 不能蓋掉。Copilot 不 merge(bridge 在 `config.tools`、app-user 在 `config.mcpServers`,兩欄位並存);Copilot 形狀需 mapper(`tools: ['*']` 必填、stdio `args` 必填)。

**Do not change casually because**：路徑用 SHARED `shelfPlacement` 規則(`architecture/transport`),read 端與 placement 端不可漂移。別在 local case 抄捷徑直接讀 `<userData>`(破壞 zero local/remote branch)。

**Related**：`skills#3`(bridge 顯示)、`skills#6`、`architecture/transport`、`agent-server/providers/{mcp-config,claude/index,copilot/index}.ts`。

## mcp#5 — No hot-reload → a per-tab "reconnect to apply" notice on change  ·  [Decision]

**Background**：MCP 不能跨 provider 即時套用(Copilot 無 session-level setter;Claude 有 `setMcpServers()` 但 v1 不用)。

**Decision**：v1「next session 生效」+ **reconnect 通知**(別讓使用者乾等)。`onMcpChanged()` 的 subscriber 在 remote re-mirror 後,對**每個 live session** emit 一條 per-tab system line:`MCP servers updated — reconnect this project to apply.`。鏡射 `skills#9` 但反向(不是 reload 是 reconnect),走同一條 session-scoped、turnId-less 的回饋軌(base send)。通知 **provider-invariant** → 攔在 provider 之上(`agent/index.ts` 的 subscriber 直接 emit,provider backend v1 不參與)。無 live session 不發。

**Do not change casually because**：別下放進 provider(答案跟 provider 無關 → 會複製邏輯)。v2 可只把 Claude 升級成真 live reload(那時才值得加 per-provider backend hook)。

**Related**：`skills#9`、`architecture/mcp-sync`、`src/main/agent/index.ts`。

## mcp#6 — Hold the app-dir `.heartbeat` lease at deploy, unconditionally  ·  [Gotcha]

**Symptom**：一個**只有 MCP、沒有 skill** 的 app,remote deploy 後 `mcp-servers.json` 消失 —— `~/.shelf/apps/<appId>/` 被 agent-server 啟動 sweep 當 orphan 回收。

**Root cause**：lease 靠 `.heartbeat`(`connection-health` / cleanup sweep)。`syncSkillsToRemote` 只在**有 skill 時**才 touch 它;`syncMcpForConnection` 設計上不 touch(靠 live agent-server 持 lease)。但 deploy 當下 agent-server 還沒發第一個 heartbeat,sweep 可能先跑 → 把剛放好、無 lease 的 dir 回收。skill-present 的 app 剛好被 skills 的 touch 救到,MCP-only 的沒有。

**Fix**：`deployAgentServer`(`agent/remote.ts`)在 deploy 後**無條件** `mkdir -p <appDir>; touch <appDir>/.heartbeat`(經 `ops`),不論有沒有 skill/mcp。app-dir lease 本就該在「有 agent 部署到該 app」時持有,與 skills/mcp 存在與否無關。**別**把這條改回「只有內容時才 touch」。迴歸測試 = `e2e/connector/agent-deploy-mcp.spec.ts`(修前紅、修後綠)。

**Related**：`connection-health`、`deployment`、`skills#1`(local 投影也 touch heartbeat)、`agent-server/cleanup.ts`、`src/main/agent/remote.ts`。

## mcp#7 — Scope is the UX problem: communicate breadth × where-it-runs  ·  [Decision]

**Background**：使用者困惑(會繼承我原生 config 嗎?這些 env 是我筆電的嗎?)不是 JSON 格式造成的,是看不到**影響範圍**。Shelf 是 control plane / remote-renderer:使用者在 client 編一次,執行主體是 **worker**。

**Decision**：用兩個 hook 傳達 scope,而非靠文件:
- **Author 端 `?` help affordance**(MCP 設定區)→ 白話講廣度(所有 project / 兩 agent / 每個 worker)+ 執行地點(在 agent 實際跑的那台機器;command 與 env 要在那;`${VAR}` 對 worker env 解析)。
- **per-worker fail-loud status**(`/mcp` 卡)是最好的老師:server 在某 worker 起不來就在那個 tab 的 `/mcp` 顯示 failed + 原因。每個 tab 的 `/mcp` 反映它自己 worker 的狀態 → 天然的 per-worker status(`skills#3` 既有的卡片,T2.2 讓 user server 流進去後即成立)。
- 推論:**不做 per-server「where it runs」override** —— 統一規則「全部在 worker 跑,跟 bash/read/edit 一樣」比 per-server locale 旋鈕好傳達。

**Related**：`skills#3`(`/mcp` 卡)、PRODUCT.md、`src/renderer/components/settings/McpSettingsTab.tsx`。
