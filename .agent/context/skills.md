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

## skills#3 — `/mcp` `/skills` provider 內部攔截 → 印 normalized 唯讀卡片（不轉發 SDK）  ·  [Decision]

**Problem**：使用者要直觀看到「這個 session 載入了哪些 MCP server / skill」。但 `/mcp` `/skills` 在兩家 CLI 都是**互動式 TUI-only、SDK/headless 不可派發**（Claude 官方：只有非互動指令可經 SDK 派發；`system/init.slash_commands` 只列 clear/compact/context/usage）。轉發給 SDK 會失敗或被當 prompt 餵模型。

**Decision**：**provider 內部攔截 `/mcp` `/skills`（像 `/model`），自己讀 SDK 結構化資料 → normalize → 印 `fold_markdown` 卡片**。renderer / wire / main **零改**（重用既有 fold 渲染）。純 provider 端。
- **資料來源（init 抓一次、cache、reconnect 刷新）**：Claude `Query.mcpServerStatus()` + `supportedCommands()`，**必須在 REAL persistent session 的 `system/init` 抓**（`refreshLoadedContext()`，full options），不是 cwd-only warmup probe（會漏 app skills + in-process bridge）；Copilot 從 `session.skills_loaded` / `session.mcp_servers_loaded` event 抓。
- **不對稱（SDK 限制）**：`source`/`enabled` 只有 Copilot 給得出；Claude `/skills` = `supportedCommands()` 去掉已知 built-ins。
- **list ↔ dispatch 必須成對**：加進 command list **且**實作攔截 —— 只列不攔會被當 prompt 餵模型。
- **cold-start read-through warm（`ensureLoadedContext`）**：cache 是 read-through —— slash handler 先 `await ensureLoadedContext()` 再讀。real session 出現後由 `refreshLoadedContext()` 持續刷新；**冷窗（開 tab、未送訊息、就打 `/mcp`）**則就地暖一次。**兩家機制不同**：Claude 的常駐 session 是 streaming-input，**未 push 訊息前不發 `system/init`**（實測：streaming 流不送訊息 15s 無 init；字串 prompt `' '` 會 init）→ 必須另開**字串 prompt 拋棄式 probe**（full options：plugins + in-process `shelf` MCP，少一樣就漏報），init 即讀即 abort；Copilot 直接 `ensureSession()`（createSession 即觸發 loaded events），等事件到。idempotent + in-flight 去重；暖機**刻意與 auth probe 分離**（載 MCP/skills 不與登入判斷 fate-share，慢/壞的 MCP 不擋開 pane）。
- **fail-loud**：暖機後 cache 仍 `undefined`（probe 真的失敗）→ 印「Could not load …」，**不謊報「none」**。

**Do not change casually because**：① 在 warmup probe（cwd-only）抓會漏掉 app skills + in-process `shelf` bridge —— 一定要在 full-options 的 session 抓（含 `ensureLoadedContext` 的拋棄式 probe，真機 `/mcp` 確認 `shelf` 有列出）。② Claude 冷窗不能改用「`ensureSession()` 不送訊息」暖機 —— streaming session 不會 init。③ 別把暖機折進 auth warmup 省一個行程 —— 會讓登入判斷被 MCP 啟動健康度綁架（`app-level-mcps` 上線後尤甚）。

**Related**：`agent-providers#1`、PRODUCT #5（原生的歸原生）、`agent-server/providers/{loaded-context,claude/index,copilot/index,fake/index}.ts`、測試 `agent-server/providers/{claude,copilot}/loaded-context-warm.test.ts`。

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
