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

**Decision**：app-level MCP **疊加**在原生之上,**不排除原生**。① 由 provider 自己載入(Claude 刻意不設 `settingSources` → native parity with raw CLI,見 PRODUCT.md #5 與 `CLAUDE_QUERY_DEFAULTS` 註解;Copilot 走 ACP 後由 `copilot --acp` CLI 自行 discover 原生 config,不再是 SDK `enableConfigDiscovery` flag)。心智模型:**native = 這台機器/帳號本來就有的(per-machine);app-level = 你要「到處都有」的(Shelf 管,跨 project/provider/worker)**。只有 app level,無 per-project MCP 層。

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
- **Claude bridge merge**:`shelf` bridge 是 sdk-type MCP server,跟 user servers 同在 `options.mcpServers` → merge,`shelf` 放**最後**讓使用者命名的 "shelf" 不能蓋掉。（**Copilot 部分已改 ACP**:bridge/user MCP 都走 `session/new.mcpServers` 兩層,見 `mcp#9`；本條的 copilot-SDK `config.tools`/`config.mcpServers` 細節屬已刪 native backend。）

**Do not change casually because**：路徑用 SHARED `shelfPlacement` 規則(`architecture/transport`),read 端與 placement 端不可漂移。別在 local case 抄捷徑直接讀 `<userData>`(破壞 zero local/remote branch)。

**Related**：`skills#3`(bridge 顯示)、`skills#6`、`architecture/transport`、`agent-server/providers/{mcp-config,claude/index,copilot/index}.ts`。

## mcp#5 — No hot-reload → a per-tab "reconnect to apply" notice on change  ·  [Decision]

**Background**：MCP 不能跨 provider 即時套用(Copilot 無 session-level setter;Claude 有 `setMcpServers()` 但 v1 不用)。

**Decision**：v1「next session 生效」+ **reconnect 通知**(別讓使用者乾等)。`onMcpChanged()` 的 subscriber 在 remote re-mirror 後,對**每個 live session** emit 一條 per-tab system line:`MCP servers updated — reconnect this project to apply.`。鏡射 `skills#9` 但反向(不是 reload 是 reconnect),走同一條 session-scoped、executionId-less 的回饋軌(base send)。通知 **provider-invariant** → 攔在 provider 之上(`agent/index.ts` 的 subscriber 直接 emit,provider backend v1 不參與)。無 live session 不發。

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

**Related**：`skills#3`(`/mcp` 卡)、PRODUCT.md、`src/renderer/components/McpView.tsx`。

## mcp#8 — MCP 管理是「右側欄 view」(Skills 的姊妹)，不是 Settings 分頁  ·  [Decision]

**Background**：MCP 管理 UI 原本埋在 Settings → MCP 分頁，但 app-level MCP 與 app-level skills 是產品心智上的同類(PRODUCT.md #5：兩者都是「App 層、Shelf 加值、跨 project/provider/worker、餵給 agent」)。Skills 在 BottomBar 有獨立右側 view，MCP 卻在 settings —— 同類東西放兩個地方，使用者覺得不一致、不好找。

**Decision**：MCP 管理是 **right-sidebar view**(`McpView`，走既有「右側欄 feature」機制：`RightSidebarFeature` 的 `'mcp'` + `mcpVisible` + `toggleRightSidebar`，跟 PM/Notes/Skills/Backup/DevTools 同一套)，從 **BottomBar 插頭 icon** 開，排在 Skills 旁(姊妹相鄰)。**唯一入口** —— Settings 不再有 MCP 分頁(source-of-truth 單一，不留兩個入口)。CRUD 邏輯與 mcp-store/IPC 行為**未變**，只是 host shell 從 settings-body 換成與其他右側 panel 相同的 `RightPanel`（見 `renderer-shell#1`）。BottomBar 右側順帶分三組(version｜左側欄｜右側欄)用分隔線區隔，降低一排 icon 的認知負擔。

**Do not change casually because**：別把 MCP 搬回 Settings 分頁、也別讓它同時存在於兩處 —— 一致性(App 層姊妹同處)是使用者主動提的痛點，分裂入口正是要修的問題。判別準則:「使用者會瀏覽/管理、跟 agent 工作流綁的 App 層內容」走 BottomBar 右側 view；純設定才進 Settings。(連線狀態 indicator 仍走 per-tab `/mcp` 卡，見 mcp#7，不在 BottomBar 加 status badge，等真有痛點再說。)

**Related**：`skills`(SkillsView 範本)、PRODUCT.md #1/#2/#5、`src/renderer/components/{McpView,BottomBar}.tsx`、`src/renderer/store.ts`(`RightSidebarFeature`)。

## mcp#9 — Copilot ACP 與 Codex app-server 各自注入 L1 Shelf bridge + L2 user MCP  ·  [Decision]

**Background**：Copilot 走 ACP `session/new.mcpServers`；Codex 走 app-server thread config 的 `mcp_servers`。兩者都消費同一份 projected user MCP source 與 Shelf built-in bridge，但 transport shape 不共用。

**Decision**：
- **L1 = Shelf built-in bridge**：app-skill CRUD + `web.fetch`/`browser.open` 使用 in-process HTTP MCP server，因 handler 必須回 main 執行 bridge tool。Copilot 轉成 ACP HTTP MCP entry；Codex 轉成 app-server `mcp_servers.shelf` URL entry。
- **L2 = user custom MCP**：兩者都讀 `loadProjectedMcpServers(appId)`；Copilot 轉成 ACP `McpServer[]`，Codex 轉成 app-server stdio/URL config，secret header/env value只留在 process env，thread config只帶 env-var名稱。
- **兩層 per-session = 天生多租戶隔離**,不需 config-home 的 `mcp-config.json`(那反而會重造 auth/skill 那種共用檔碰撞)。

**KNOWN LIMITATION（已知、接受的 regression)**：**`copilot --acp` 靜默不載入經 `session/new` 傳入的 stdio MCP server**（http 正常 → L1 bridge 連得上,但使用者的 `npx …` stdio server 不出現在 `/mcp`)。上游 bug **github/copilot-cli #1040(open)**,Shelf 側已驗證 config 投影/轉換/傳送皆正確。**DECIDED 接受**(MCP 困擾 < skill;非 cutover blocker)。**追蹤在 `.agent/UPSTREAM_WATCH.md`** —— 上游修了才回收(可省掉備案的「把 stdio server 包成 in-process http」workaround)。

**Do not change casually because**：L1 一定要 in-process http（stdio 子進程無法回 main 執行 bridge tool);別把 L2 user MCP 挪去 config-home（per-session 已多租戶隔離,config-home 會重造碰撞);stdio MCP 在 copilot 失效是上游 #1040,不是 Shelf bug —— 別在 Shelf 側「修」（絕對路徑也沒用,見 UPSTREAM_WATCH)。

**Related**：`mcp#4`、`agent-providers#13`、`agent-providers#33`、`.agent/UPSTREAM_WATCH.md`、`agent-server/shelf-mcp.ts`、`agent-server/providers/acp/mcp.ts`、`agent-server/providers/{copilot,codex}/index.ts`。

## mcp#10 — Built-in HTTP bridge bounds request bytes and tool-input elements  ·  [Decision]

**Decision**：`shelf` in-process MCP bridge 對 POST body 設 **2 MiB** 上限，讀取每個 chunk 時先累加位元組數，超限立即回 HTTP 413 並丟棄已收集的 chunks；SDK `McpServer` 的 `maxToolInputElements` 設 **1,024**，限制 `tools/call` 參數的 object members 與 array elements。正常大小的 request、恰好在上限的 request，以及超限後的新連線仍可使用。

**Reason**：bridge 雖只綁 `127.0.0.1`，同機器上的其他 process 仍可連到無認證的 endpoint。SDK 1.32.x 的 element 防護須顯式啟用；bridge 先自行解析 JSON 再把 object 傳給 transport，會繞過 SDK transport 的 body reader 上限。Element count 也管不到單一巨大的字串，例如 skill 內容或 web request body，因此兩種限制都需要。2 MiB 容得下正常的文字內容，1,024 elements 高於目前 header record 與 note list 的日常需求。

**Do not change casually because**：不要只升 SDK 版號就假設防護已啟用，也不要改成收完 body 才檢查大小。若真有超過上限的合法內容，先確認實際工作流，再評估提高上限或分段傳輸；不要直接移除限制。Shelf 的 production code 直接使用 SDK server，沒有直接使用其 client redirect 或 bearer-auth middleware；升級時不應為不存在的 consumer 放寬 same-origin redirect 預設。

**Related**：`agent-server/shelf-mcp.ts`、`agent-server/shelf-mcp.test.ts`、`mcp#9`。

## mcp#11 — Reserve the exact shelf server name at Shelf authoring boundaries  ·  [Decision]

**Decision**：Shelf 新增外部 MCP server、將其他 entry 改名為 `shelf`，以及 Backup Import
匯入該名稱時，使用 `validateAuthoredMcpEntry` 拒絕。只精確保留小寫 `shelf`，不保留
整個 prefix；`Shelf`、`SHELF`、`shelf-tools` 仍是不同名稱。Import 清單將該 source item
標為 invalid 並提供原因；apply 即使直接指定 item id，也須在任何 live 寫入前再次驗證。

**Reason**：內建 Shelf MCP server 使用 `shelf` 作為配置 key；同名 user entry 會依 provider
merge 方式造成覆蓋或重名。此限制屬於 Shelf 管理設定的寫入政策，不應以 provider 的載入
錯誤來實現，也不能只在 UI 表單阻擋而讓 Import 繞過。

**Do not change casually because**：schema validator `validateMcpEntry` 保持接受既有 `shelf`
資料，讓 list/get、原名編輯、改名移出、刪除與未選取資料保存仍可運作。既存 entry 不自動
刪除，provider parser 仍可讀取；HTTP adapters 的內建名稱隔離另見 mcp#14。不可將
authoring error 混進 runtime parser errors，因為 Codex 對該 errors 集合採 fatal 處理。
這項政策不改寫 provider 原生的
project-level MCP config，也不限制 server 內部 tool 名稱。

**Related**：`src/shared/mcp.ts`、`src/main/mcp-store.ts`、`src/main/config-backup/import.ts`、`contracts/persistence-formats`。

## mcp#12 — Share Shelf tool contracts, encapsulate protocol and provider differences  ·  [Decision]

**Decision**：Shelf 控制的工具名稱、描述、input schema 與 main operation 定義在共用
`SHELF_BRIDGE_TOOLS`，不依賴 provider SDK。現有工具的參數皆直接同名映射，共用
`bridgeToolArgs` 只選取 schema 宣告欄位。`runBridgeTool` 共用 main RPC 與文字／錯誤
狀態轉換；SDK／MCP 的註冊、驗證整合與 result envelope 留在各 adapter。
Claude 保留 SDK in-process MCP；Copilot ACP 與 Codex app-server 保留 HTTP MCP。
HTTP host 位於 agent-server 共用層，不歸 ACP 所有；ACP entry 與 Codex thread config
各由對應 adapter 轉換。

**Reason**：共同契約避免同一工具在不同入口出現 schema／操作映射差異；不同 SDK
的串接方式不應滲入 Shelf 共用層。使用相同 MCP host 不代表兩個 provider 使用相同
Agent 通訊協定，也不構成統一 transport 的理由。

**Do not change casually because**：共用的是 Shelf 語意與真正相同的行為，不是跨 SDK
註冊框架。無參數工具在 HTTP 省略 schema、Claude 傳空 shape，是 adapter 的相容性
處理。新增不同名映射時須明確擴充契約，不能讓 provider 私下改寫工具語意。
契約測試固定兩個 adapter 的對外 schema、main op／參數及成功／失敗回傳，避免兩邊
一起改錯仍只因相互一致而通過。

**Related**：`agent-server/app-tool-tools.ts`、`agent-server/shelf-mcp.ts`、`agent-server/shelf-tool-contract.test.ts`、`contracts/app-tool-bridge`。

## mcp#13 — Project signing keys authorize individual execution endpoints  ·  [Decision]

**Decision**：main 首次授權某 Project 時產生 Ed25519 key pair，在本次 App runtime
記憶體內重用；私鑰不 export／落盤／送往 exec。exec 產生新的 endpoint UUID，經
既有 app-tool RPC 取得 public key 與 detached-signature Bearer。簽章同時綁定固定
domain 版本、可信 Project、可信 Agent session 與 endpoint nonce。main 從通道取得
Project／session context，不接受 args 指定 scope；公鑰只從該可信 bootstrap 取得，
不從 HTTP request 取得。此 internal op 不列入模型的工具清單。

**Reason**：Project 是一對多授權範圍，而 token 是個別 endpoint 的存取資格。
共用公鑰不代表同 Project 的所有 token 都能互用；即使其他 session 要求簽署同一
nonce，因可信 session 不同也無法產生目標 endpoint 接受的簽章。與每 Agent 一組
key 相比，新增 Agent／重連只需簽發新 token，不用改變 Project 的簽發身分。

**Do not change casually because**：這是授權簽章，不是加密或 proof-of-possession。
Bearer 在該 endpoint 有效期間仍可重放；可讀取 provider env／exec 記憶體的同權限
程序不在此隔離保證內。Project 私鑰洩漏影響整個 Project。此機制不取代 main 的
每工具權限與資源檢查，也不為不同工具或原生 MCP subprocess 建立新的 sandbox。

Token 沒有固定 wall-clock TTL，以 endpoint incarnation／關閉作有效期，避免長時間
Agent 在沒有可用續期通道時中斷。App 重開換 key；Agent exec 重建換 nonce／token；
同次 App 執行內重連可保留 Project key。正常 shutdown 先停用 host 再 reap，程序
終止也會移除 listener。若失聯遠端仍存活，它要等既有連線關閉／watchdog 終止才失效，
不宣稱 main 記憶體的 key 消失會即時撤銷遠端公鑰。此設計依目前一 session 一 exec
政策；未來多 session 共用 exec 時必須重新設計 host 的 caller binding。

Bootstrap 必須在 listen 前完成，有 10 秒上限，失敗不回退無認證。授權 RPC 使用
endpoint-specific request id，避免 dispatcher 以相同 sid 重建 exec 時，舊回覆撞上
重置的流水號；timeout 移除 waiter。Host／Origin／path 是額外邊界，不是身分認證。
保留 request bytes 與 tool-input elements 防護。Copilot 走 ACP header mapper；
Codex 在 spawn 前注入 token env，thread config 只帶 env 名稱。Claude SDK 不切 HTTP。

**Related**：`contracts/app-tool-bridge`、`agent-server/shelf-mcp-auth.ts`、`src/main/agent/shelf-mcp-authority.ts`、[Node crypto sign/verify](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptosignalgorithm-data-key-callback)。

## mcp#14 — Shelf HTTP startup failure disables tools, not the Agent  ·  [Decision]

**Decision**：exec 持有 lazy Shelf HTTP lifecycle，只嘗試啟動一次並快取 endpoint
或失敗。授權失敗、listener 啟動失敗或其他啟動錯誤時，Copilot／Codex 省略內建
Shelf MCP，仍可啟動 Agent。session 狀態經 main／IPC／event bus 到 per-tab store；
一般與登入 pane 均顯示不可關閉警告。狀態不存入對話歷史；清除對話、starting／ready
與 component remount 不清警告，只有明確 available 回報才移除，重建 exec 才重試。
Claude 使用獨立 SDK 通道，不因 HTTP host 故障被標為不可用。

**Reason**：這是 failure-handling#1 的具體套用：可用性可局部降級，認證不可降級。
不回退無認證 listener 或替代 bridge。HTTP adapters 在組裝 user MCP config 時
排除精確同名 `shelf` 並記錄警告，不改原始設定，不擋 `shelf-*`；否則既存 user entry
可能覆寫內建 endpoint，或在啟動失敗時成為冒充內建能力的替代品。共同 parser 仍
保留原有驗證規則與錯誤，不把此排除變成 Codex 的 fatal config error。

**Do not change casually because**：available 只代表 host 啟動成功，不保證 provider
已連上，不是 runtime health check。單次不合法 HTTP request 只被拒絕，不改全域
availability；否則未授權 caller 可故意送錯 token 來停用正常服務。警告只帶固定
失敗分類，不帶授權內容或任意 error text；診斷記錄 stage 與可用的 OS errno，
不將可能含 secret 的 bootstrap error 原文寫入 log。
