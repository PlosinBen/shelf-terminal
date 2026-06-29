---
type: context
title: Skills
related:
  - architecture/skills-projection
  - context/deployment
  - context/connection-health
---

# Skills

> App-level Agent Skills：跨 project、Claude/Copilot 共用的 `SKILL.md`，UI 編輯 → 投影 → provider 載入。
> 投影/部署的母規則見 `deployment`；heartbeat lease 見 `connection-health`。

## skills#1 — App 層 Agent Skills（開放標準 + 投影）  ·  [Decision]

**Background**：要 app 層、跨 project、Claude/Copilot 都能用的 skill。Agent Skills 是開放標準（`SKILL.md`），兩家原生吃，但沒有共用的自訂目錄機制：Claude SDK 不認 env/settings 自訂路徑（只認寫死 `~/.claude/skills`），Copilot 走 `skillDirectories`。

**Decision**：
- **Source of truth = `<userData>/skills/`**（Shelf UI 編輯，`skills-store.ts` CRUD）。layout 即 Claude **plugin root**：`.claude-plugin/plugin.json`（`{name:"shelf-skills"}`）+ `skills/<name>/SKILL.md`。SKILL.md 視為使用者 opaque raw md（store 只 parse name/description）；**frontmatter `name` = identity**，存檔 rename folder（kebab 驗證 + 撞名檢查）。
- **消費端 = 投影 + 兩家各自指**（`deployment#1` 的第一個實例）：投影到 `~/.shelf/apps/<appId>/skills`（local fs cp = `skills-projection.ts`；remote = `remote.ts syncSkillsToRemote`，content-hash `.synced` gate）。Claude `options.plugins=[{type:'local',path:<root>}]`（自訂目錄的唯一官方解法，skill 顯示為 `shelf-skills:<name>`）；Copilot `createSession({skillDirectories:[<root>/skills]})`。renderer 對此無感（守 `agent-providers#1`）。
- **載入時機 = 持久 session 建立時**（`background-tasks#3`）；skill 改完由 `skills#4` hot-reload 進 live session、免重連。`scripts/verify-skill-loading.mjs` 驗 Claude 載入。
- **appId = `app-instance-id.ts` 的 userData UUID**（`deployment#1` 隔離 key）。

**Do not change casually because**：
- 別為 Claude 改用 `settingSources` / 塞 `~/.claude/skills` —— `plugins` 是官方自訂目錄解法且不汙染使用者目錄。
- 別在 renderer 分流 provider（Claude 帶 namespace、Copilot 不帶）或感知 skill 載入細節。
- 投影/sync 完**必須** touch `apps/<appId>/.heartbeat`，否則被 agent-server 啟動 sweep 當 orphan 回收（見 `connection-health#3`）。
- **別把 `skills/skills` 兩層化簡成單層** —— 內層 `skills/` 是 Claude plugin 格式強制（`<root>/skills/<name>`），外層刻意 = source 即 plugin root，換取投影**零路徑改寫**（直接 `cpSync`，Claude 指 root、Copilot 指 `root/skills`）。化簡頂多改外層名（純美觀），代價是動態合成 plugin root + 改寫 relpath + 連動 hash gate / remote sync。

**Open**：Copilot 載入 skills 仍待真機驗（目前無 session 可測）。

**Related**：`deployment#1`（投影母規則）、`connection-health#1`（heartbeat lease）、`skills#2`（bridge）、`skills#4`（hot-reload）、`agent-providers#1`、`src/main/{skills-store,skills-projection,app-instance-id}.ts`、`agent-server/providers/{shared,claude/index,copilot/index}.ts`、`src/renderer/components/SkillsView.tsx`。

## skills#2 — App-skill bridge：agent 經 in-process MCP 改 client-owned skills + 統一 mutation pipeline + lock  ·  [Decision]

**Problem**：讓 agent 自己新增/修改 app 層 skills（`skills#1`）。source-of-truth 在 **client/main**（`<userData>/skills`），但 agent 跑在 **remote / agent-server**。需要跨 provider、不讓 renderer 感知 provider 細節（守 `agent-providers#1`）的路徑，且要防「agent 亂改全域 skill 污染所有 session」。

**Decision A — in-process MCP 當 RPC bridge，不是真 server**：兩 provider 各用自家 SDK 的 in-process 工具機制註冊「shelf」工具（claude `createSdkMcpServer({type:'sdk'})`+`tool()`；copilot `defineTool`+`session.registerTools`），handler **不在 agent-server 做事**，而是 `callMain(op,args)` emit `{type:'app_tool',…}` 經 stdio wire 給 main → main `handleAppTool` 動 `skills-store` → 回 `app_tool_result`。**client 才是真正執行主體**，renderer 完全無感。

**Decision B — main 端 dispatcher 用 `op=resource.verb` registry**（`agent/app-tool.ts`，純函式可單測）：每筆標 `safe`；read（`app_skill.list/get`）免確認，write（`create/update`）走 provider tool-permission。`create` 用 placeholder+rollback；`update` 先 guard「存在且未 locked」（見 `skills#5`）。**不開 `delete` 給 agent**（高風險，同 UI-only 立場）。

**Decision C — 統一 mutation pipeline**（`skills-sync.ts onSkillsChanged()`）：所有觸發點（manager UI 的 `ipc/skills.ts`、agent bridge 的 `app-tool.ts`）mutation 後**只呼叫 `onSkillsChanged()`**：①本機 re-project ②跑 subscribers（remote re-mirror + hot-reload，由 `agent/index.ts` 經 `subscribeSkillsChanged` **反向注入**避免 `remote→app-tool→skills-sync` import cycle）③`SKILLS_CHANGED` 通知 renderer。觸發點只負責寫 store + 喊一聲。

**Decision D — per-skill lock（防全域污染）**：`update` 雖被 permission gate，但 **bypass/allow-all 會繞過** → lock 是不受權限模式影響的硬性「agent 別碰這顆」。folder 內 `.locked` marker（`isSkillLocked`/`setSkillLocked`；**in-folder → rename 自動帶走**），`app_skill.update` 在 **main 端**檢查 locked 就報錯（remote agent + bypass 都擋得住）。manager UI 永遠能改/解鎖；**agent 無解鎖工具**（同 delete 立場）。

**Do not change casually because**：`updateSkill` 的 upsert 行為是 create flow 的依賴（placeholder → 寫入），lock 與「不准 upsert 新建」都是 **bridge 層的契約**，守門加在 `app-tool.ts`、**不要動 store**（見 `skills#5`）。

**Related**：`skills#1`、`deployment#1`、`agent-providers#1`、`background-tasks#3`、`src/main/agent/app-tool.ts`、`src/main/{skills-sync,skills-store,ipc/skills}.ts`、`agent-server/{app-tool-client,app-tool-tools}.ts`、測試 `app-tool.test.ts` / `skills-store.test.ts`。

## skills#3 — `/mcp` `/skills` provider 內部攔截 → 各自組 md 唯讀卡片（不轉發 SDK）  ·  [Decision]

**Problem**：使用者要直觀看到「這個 session 載入了哪些 MCP server / skill」。但 `/mcp` `/skills` 在兩家 CLI 都是**互動式 TUI-only、SDK/headless 不可派發**（Claude 官方：只有非互動指令可經 SDK 派發；`system/init.slash_commands` 只列 clear/compact/context/usage）。轉發給 SDK 會失敗或被當 prompt 餵模型。

**Decision**：**provider 內部攔截 `/mcp` `/skills`（像 `/model`），讀自家 SDK 結構化資料 → 各自組 markdown → 印 `reply`**。renderer / wire / main **零改**。**不建跨 provider 共通 result type** —— 各 provider 用自己的形狀組卡片（`{claude,copilot}/helpers.ts` 的純函式 formatter），只共用無語意排版工具 `md-table.ts`。見 `agent-providers#6`（含為何共通 normalized type 會權責倒置）。
- **資料來源（init 抓一次、cache raw、reconnect 刷新）**：Claude `Query.mcpServerStatus()` + `supportedCommands()`，**必須在 REAL persistent session 的 `system/init` 抓**（`refreshLoadedContext()`，full options），不是 cwd-only warmup probe（會漏 app skills + in-process bridge）；Copilot 從 `session.skills_loaded` / `session.mcp_servers_loaded` event 抓。cache 存 **raw SDK 結果**，讀時才 format。
- **`/mcp` 卡 = 兩張表**：servers 表（Server · Status [· Source]）+ 扁平 tools 表（Tool · Server · Description,跨 server 聚合;無任何 tool 時省略）。兩家同形（各自用 `mdTable` 組,不共用語意型別）。Claude `mcpServerStatus()` 每 server 直接帶 `tools[]`（+`readOnly`/`destructive` annotations,以 `_(…)_` 後綴呈現在 Tool 格）。Copilot 的 `mcp.list()`/event/`mcp.discover()` **都不帶 per-server tools** → 真實外部 server 只進 servers 表;**要補其 tools 得走 client `tools.list()` + `namespacedName`（`server/tool`）前綴 group,未驗證、deferred（等 `app-level-mcps` 有東西可測）**。
- **in-process `shelf` bridge 兩家都要顯示（可用性）**：bridge（`list_app_skills`/.../`web.fetch`）是 in-process 工具,**Claude SDK 把它包成 MCP server `shelf`**（`mcpServerStatus()` 直接含,帶 tools）；**Copilot 把它註冊成 `config.tools`、不是 MCP server**（`mcp.list()` 不含）。為了兩家一致都看得到,Copilot `/mcp` **主動補一個 `shelf` 條目**,其 tools 取自單一來源 `app-tool-tools.ts` 的 `SHELF_BRIDGE_TOOLS`（與註冊同源、不漂移）。bridge 永遠顯示;真實 server pull 失敗只加 fail-loud 註記、不藏 bridge。
- **不對稱（SDK 限制）**：`source`/`enabled` 只有 Copilot 給得出；Claude `/skills` = `supportedCommands()` 去掉已知 built-ins。各 provider 卡片本就不同 —— 在 `agent-providers#6` 下合法。
- **list ↔ dispatch 必須成對**：加進 command list **且**實作攔截 —— 只列不攔會被當 prompt 餵模型。
- **cold-start read-through warm（`ensureLoadedContext`）**：cache 是 read-through —— slash handler 先 `await ensureLoadedContext()` 再讀。**冷窗（開 tab、未送訊息、就打 `/mcp`）**就地暖一次。**兩家機制不同,都源於「載入訊號要等第一個 turn」**：
  - **Claude**:常駐 session 是 streaming-input，**未 push 訊息前不發 `system/init`**（實測:streaming 流不送訊息 15s 無 init;字串 prompt `' '` 會 init）→ 另開**字串 prompt 拋棄式 probe**（full options:plugins + in-process `shelf` MCP,少一樣就漏報）,init 即讀 `mcpServerStatus()`/`supportedCommands()` 即 abort。real session 出現後由 `refreshLoadedContext()` 持續刷新。
  - **Copilot**:`skills_loaded`/`mcp_servers_loaded` event **在第一個 turn 才發、不是 bare `createSession()`**（症狀:冷窗按 `/mcp` 回 "failed to initialize"）→ 不等事件,改**直接 pull** `session.rpc.mcp.list()` / `session.rpc.skills.list()`（deterministic）。event 仍負責後續 turn/reconnect 的刷新。
  - 暖機**刻意與 auth probe 分離**（載 MCP/skills 不與登入判斷 fate-share,慢/壞的 MCP 不擋開 pane）;idempotent、per-listing（部分 event 已填則只補缺的）。
- **fail-loud**：載入真的失敗 → 印「Could not load …」，**不謊報「none」**。`/skills` 整張 fail-loud；`/mcp` 因為 `shelf` bridge 永遠在,失敗時仍顯示 bridge + 加一行「無法載入已設定的 MCP server」註記。

**Do not change casually because**：① 在 warmup probe（cwd-only）抓會漏掉 app skills + in-process `shelf` bridge —— 一定要在 full-options 的 session 抓（含 `ensureLoadedContext` 的拋棄式 probe，真機 `/mcp` 確認 `shelf` 有列出）。② Claude 冷窗不能改用「`ensureSession()` 不送訊息」暖機 —— streaming session 不會 init。③ 別把暖機折進 auth warmup 省一個行程 —— 會讓登入判斷被 MCP 啟動健康度綁架（`app-level-mcps` 上線後尤甚）。

**Related**：`agent-providers#1`、`agent-providers#6`、`skills#2`、PRODUCT #5（原生的歸原生）、`agent-server/{app-tool-tools,providers/md-table,providers/claude/index,providers/claude/helpers,providers/copilot/index,providers/copilot/helpers,providers/fake/index}.ts`、測試 `agent-server/providers/{claude,copilot}/{loaded-context-warm,mcp-skills-cards}.test.ts`。

## skills#4 — App-skill live hot-reload：skill 改完免重連即生效  ·  [Decision]

**Problem**：plugins/skillDirectories 在持久 session 建立時載入一次（`background-tasks#3`），所以 skill 改完預設要下一個 session 才生效。使用者直覺是「改完最多 reconnect 就該吃到新的」，但**連線跨 project 共用**（真重連得 disconnect 所有 project），且 reconnect 走 `resumeSession`/resume pointer **會把舊 skill 快照接回來、根本沒重掃** → 改完怎樣都看不到新的。

**Decision**：兩家 SDK 都有 live-reload API，接成 `ServerBackend.reloadSkills?()`，掛在 `onSkillsChanged()` 下游：skill 改 → 自動 reload 進每個 live session，**免重連、不丟對話歷史**，該 session **下一個 turn** 生效。
- Copilot `session.rpc.skills.reload()`；Claude `query.reloadPlugins()`（回傳 refreshed `commands`/`mcpServers` → 更新 `/skills` `/mcp` cache）。best-effort：無 live session = no-op，失敗則退回「下次 init 生效」。
- **觸發鏈**：`onSkillsChanged()` → `subscribeSkillsChanged` → local session 立即 reload；remote session **先 `syncSkillsForConnection` 再 reload**（sync 失敗就不 reload，免重載舊檔）→ `reload_skills` wire → agent-server dispatch 對**所有 backend**（skill 是 app 全域）。

**Do not change casually because**：別把「reconnect 才生效」當解（跨 project 共用 + resume 接回舊快照）；也別為 reload 改走 fresh `createSession`（會丟 CLI 端對話記憶）—— 有 in-place reload API 就用它。Claude 有 slash-index 限制見 `skills#7`。

**Related**：`skills#1`/`skills#2`/`skills#3`、`agent-providers#1`、`src/main/agent/{index,remote,types}.ts`、`agent-server/{index}.ts`、`agent-server/providers/{types,claude/index,copilot/index}.ts`。

## skills#5 — `skills-store.updateSkill` 是 upsert，對不存在的 name 會「靜默新建」  ·  [Gotcha]

**Symptom**：agent 經 `update_app_skill` 改一個打錯/不存在的 skill name，竟然**成功**並建出新 skill（而非報錯）。

**Root cause**：`updateSkill(currentName, content)` 同名分支 `mkdir+writeFile`、rename 分支來源不存在時也 `mkdir`，本質是 **upsert**。這是刻意的 —— `createSkill` flow 依賴它（placeholder dir → `updateSkill` 寫內容）。但 bridge 的 `app_skill.update` 契約是「只覆蓋既有」，直接信任 store 就 fall through 成新建。

**Fix**：守門加在 **bridge 層**（`agent/app-tool.ts` 的 `app_skill.update`）：先 `getSkill(name)===null → 報錯`（指引去 `create_app_skill`），再查 `isSkillLocked`。**別把 `updateSkill` 改成非 upsert** —— 會打斷 create flow 的 placeholder 寫入。store 維持 upsert、由 bridge 補契約（`skills#2`）。

## skills#6 — SKILL.md frontmatter 無效 YAML → Copilot 默默跳過該 skill（Claude 卻載得到）  ·  [Gotcha]

**Symptom**：在 SkillsView 存了 skill，**Claude 用得到、Copilot 完全載不到**，且兩邊零錯誤訊息，重啟/重連都救不了。

**Root cause**：frontmatter 某值（最常見是 `description`）**未引號卻含 `: `（冒號+空格）**，是無效 YAML。Copilot CLI 用嚴格 parser → 解析失敗 → 整個 skill 被跳過；Claude loader 寬鬆 → 照載。而 Shelf 的 `parseSkillMeta` 是 regex 寬鬆解析（只抽 name/description），所以這種檔**存得進去、零警告**，延後到 Copilot 端才無聲爆掉。

**Fix**：`updateSkill`（UI 與 agent bridge 寫入的**共用 chokepoint**）寫檔前用 `js-yaml` 嚴格 parse frontmatter（`validateFrontmatterYaml`），不合法回 `{ok:false,error}`。使用者修法：含冒號的值包雙引號（`description: "a: b"`）。**別**用 regex 半套驗證（只擋冒號會給假安全感，其他 YAML 破綻照漏）；**別**把驗證放 renderer（agent bridge 那條會繞過）—— 放共用 `updateSkill` 才兩條路都守得到。

## skills#7 — Claude `reloadPlugins()` 熱重載後，全新 skill 的 `/` slash 仍可能 "Unknown skill"  ·  [Gotcha]

**Symptom**：hot-reload（`skills#4`）後**新增**一個 skill，model 用得到，但直接打 `/<新skill名>` 回 "Unknown skill" 或不進 autocomplete —— 要整個 restart 才正常。

**Root cause**：`query.reloadPlugins()` 重掃磁碟、把新 skill 餵進 **model-facing** 能力集，但**不重建 `/` slash 解析索引**。這是 SDK 行為，不是我們的 bug。

**Fix**：認知差異即可。**改既有 skill 內容不受此限**（名稱已在索引），只有「全新 skill 名稱」會這樣，且 model 仍可主動使用；我們 `/skills` 卡用 `reloadPlugins()` 回傳值自己重組、會即時反映。**別**為此把 reload 改成 fresh session（會丟對話歷史）。Copilot `skills.reload()` 無此問題。

## skills#8 — 多檔 skill：SKILL.md 維持特權，aux 檔走通用 file ops（agent 經 bridge 管理 scripts）  ·  [Decision]

**Background**：skill 資料夾可帶 aux 檔（`scripts/`、`reference.md`）。**消費端本來就 folder-aware**（投影是整棵 `cpSync`、兩家 SDK 都指資料夾 root 原生載入）—— 缺的只有 **authoring**：app-tool bridge 原本只把 SKILL.md 當一個字串（`get/create/update`），agent 看不到也管不到 aux 檔。

**Why bridge（不是 worker 直接寫）**：投影到 worker 的是**下游 copy**，每次 `onSkillsChanged()` wipe-and-copy 覆寫。agent 可在 worker bash *讀* 那些檔，但 *改* 會被下次投影蓋掉、永不回流真相源 → 寫入**必須**經 bridge（同 SKILL.md 走 bridge 的理由）。

**Decision**：
- **SKILL.md 維持特權**：identity（frontmatter `name`）、rename、YAML 驗證、lock 都綁它 → 仍由 `update_app_skill` 獨佔，**不可降級成普通檔**。aux 檔走另一組通用 `*_file` ops（`read/write/delete_app_skill_file`），內容當 opaque utf-8。`get_app_skill` 加吐 `files`（aux 路徑清單，排除 SKILL.md/.locked），agent 才知道有 scripts。
- **Full CRUD**（非唯讀）：authoring 含 script 的 skill 要能*建*出 script，唯讀會讓 SKILL.md 引用一個生不出來的檔 → 壞 skill。
- **路徑封閉 = security gate**：store 的 `resolveAuxPath(name, rel)` 是唯一閘 —— resolve 進 `skillDir` 內，blank/絕對/backslash/drive-letter/`..`-escape/保留字（`SKILL.md`/`.locked`）一律 null，「resolve 後仍在 skillDir 內」是權威檢查。
- **無孤兒不變式**：保留 `SKILL.md`（`*_file` 刪不到）+ **不開 whole-skill delete 給 agent**（UI-only）→ **沒有任何 bridge 路徑能拿掉 SKILL.md**，skill 不會變「有 script 沒 SKILL.md」。防呆：`listSkills` 本就跳過無 SKILL.md 的資料夾。
- **Lock 一致（但只對 agent）**：lock = 「agent 整顆別碰」，aux 檔 write/delete 在 **bridge/main 端**也擋（bypass mode 也守得住）；read 仍允許。**manager UI 不受 lock 約束**（lock 只 fence agent，使用者永遠能改，同 SKILL.md/unlock 立場）→ UI 的 aux IPC handler 直接打 store、不檢查 lock。
- **良性中間態不報錯**：寫了一個 SKILL.md 還沒引用的 script（或反之）照投影、引用補上即生效。
- **Manager UI 同樣 full CRUD（與 agent 對齊）**：`SkillsView` editor 多一個 `activeFile` 維度 —— SKILL.md 走 `skills.update`（特權：驗證/rename），aux 檔走 `skills.writeFile`/`deleteFile`（新 IPC `skills:*-file`，寫入照樣 `onSkillsChanged()` 重投影）。Files 清單**沒 aux 檔就隱藏**（簡單 skill 視覺零變）；Preview 只對 SKILL.md/`*.md`，script 純文字編輯。

**Out of scope**：binary 檔（bridge 與 UI 都是字串/utf-8 模型，text-only）；rich code 編輯（syntax highlight/LSP，UI 維持純 textarea）；chmod/exec bit/runtime deps（使用者環境問題，寫檔 0644）。

**Do not change casually because**：別把 SKILL.md 併進通用 file ops（會丟掉 identity/rename/YAML/lock 語意）；別把保留字檢查從 `resolveAuxPath` 搬走（無孤兒不變式靠它 + no-agent-delete 兩者共同成立）。

**Related**：`skills#2`（bridge + 統一 mutation pipeline）、`skills#4`（hot-reload，aux 寫入同樣 `onSkillsChanged()`）、`contracts/app-tool-bridge`、`src/main/{skills-store,agent/app-tool,ipc/skills}.ts`、`src/renderer/components/SkillsView.tsx`、`agent-server/{app-tool-tools,providers/claude/index,providers/copilot/index}.ts`、e2e `skills.spec.ts`。

## skills#9 — App-skill reload 在 agent view 顯示回饋（不再靜默）  ·  [Decision]

**Problem**：`skills#4` 的 hot-reload 是 **fire-and-forget**——`reloadSkills()` 回 `void`、成功只進 agent-server stderr，**什麼都不回 renderer**。使用者改完 skill，reload 默默發生,無從得知「我的編輯到底有沒有進到正在跑的 agent」。

**Decision**：reload 完由 **provider 在 agent view 顯示一條線**（成功 system 分隔線 `Skills reloaded`、失敗既有 error 樣式），責任切分清楚：
- `SKILLS_CHANGED` IPC = **sidebar 的事**（刷新 Skills 面板 list），與此無關。
- agent-view 回饋 = **agent-server 的事**：`reloadSkills()` 改回傳 `{reloaded, ok, error?}`；`reload_skills` handler 依結果**用 base send** emit `skills_reloaded`（session-scoped、turnId-less），main 合成 system/error `AGENT_MESSAGE` 到該 tab。
- **per live session**：skill 是 app 全域,一次編輯 reload N 個 live session,每個在自己的 tab 各顯示一條;沒 live session(`reloaded:false`)不顯示。
- 失敗走 **fail-loud**(error 線),正好落在 reload 完那個時間點。

**Do not change casually because**：別把回饋掛回 `SKILLS_CHANGED`(那是 sidebar，不分 tab、不知 reload 結果);emit 必須走 base send 而非 turn send(turn-less,且 reload 不在任何 turn 裡 —— 見 `architecture/agent-turn` 的 content session-scoped 投遞)。wire 規格見 `contracts/agent-routing` 的 `skills_reloaded`。

**Related**：`skills#4`(hot-reload)、`contracts/agent-routing`(`skills_reloaded` wire)、`architecture/agent-turn`(turnId-scoping / session-scoped 投遞)、`agent-server/{index,providers/{claude,copilot}/index}.ts`、`src/main/agent/{turn-dispatcher,remote,index}.ts`、e2e `app-tool.spec.ts`。
