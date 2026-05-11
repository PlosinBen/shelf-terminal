# Agent View Message Type Architecture

## 問題

Renderer 顯示 agent 訊息的詞彙散落在多處，每接一個新 provider / 新 SDK event 類型就要改三、四個檔案，且沒有 type-safety 把關。

具體痛點：

1. **訊息類型詞彙分散** — provider 端 ad-hoc 字串（`agent-server/providers/types.ts` 的 `OutgoingMessage` 是 `[key: string]: unknown` 的 free shape），main process 端有 `AgentMessagePayload.type` union，renderer 端有 `AgentMsg.type` union，三者各自為政。
2. **Provider → renderer mapping 是 ternary** — `AgentView.tsx:266` 寫死的 `msg.type === 'tool_use' ? 'tool_use' : msg.type === 'text' ? 'assistant' : ... : 'system'`。漏命中的 msgType 默默 fallback 成 `'system'`，沒 TS 錯誤、沒 runtime warning。
3. **加新訊息類型工作量大** — Copilot 的 `report_intent`（agent announce「我接下來要做 X」）想要差異化顯示，但加一個 type 要動 provider / agent-server type / renderer mapping / AgentMessage 渲染分支 / CSS。容易漏。
4. **Dead channel 沒清** — Claude 發 `msgType: 'result'` 是 turn 結束的 cost/tokens 摘要，但 renderer 直接 drop（`AgentView.tsx:258`）。token/cost 從 `status` payload 拿。`'result'` 是 dead 但還是天天傳。
5. **命名不一致** — provider 說 `'text'`，renderer 內部叫 `'assistant'`，需要 ternary 額外做 `'text' → 'assistant'` 轉換；provider 說 `'plan_update'`，是動詞語法跟其他 type（名詞）格格不入。
6. **共用 type 沒有單一來源** — `AgentMessagePayload.type` 在 `src/main/agent/types.ts` 有 union，agent-server 的 `OutgoingMessage` 在 `agent-server/providers/types.ts` 是 free string；agent-server 是子 process，能 import `src/shared/` 但目前沒這麼用。

不合理的地方：renderer 對 provider 詞彙知道太多，provider 又有空間隨便發 string。

## 設計目標

1. **Renderer 訂死合法 msg.type 集合** — 明確列舉哪些訊息類型 UI 會處理，哪些行為（卡片、單行 dim、sticky panel、被 drop）。
2. **Provider 是翻譯層** — 各 SDK 把自家事件翻譯成 canonical type；renderer 不認得任何 SDK-specific 詞彙。
3. **Type-safe dispatch** — 把 ternary 換成 discriminated union + exhaustive switch，漏 case TS 直接 error。
4. **單一來源** — canonical type 放在 `src/shared/types.ts`，agent-server / main / renderer 三邊都 import 同一份；agent-server 是 provider 跟 renderer 共用，**外部詞彙統一，不再有「內部 / 外部」雙詞彙**。
5. **未來擴充友善** — 加新 type 改一個 union variant + 一個 switch case + 一個 render 分支即可，不會偷偷 fallback 成 `'system'`。

## 提議的 Canonical Message — Discriminated Union

放 `src/shared/types.ts`。**Canonical type 不是字串 union，是完整的 discriminated union**：每個 variant 自帶它真正需要的欄位，TS switch 之後直接 narrow 到精準 shape，不需要強迫所有 variant 共享 optional 欄位（`content?`、`toolName?` 散滿一條 type 是 anti-pattern）。

```ts
export type AgentMessage =
  // 純文字類 — 一發一個，只有 content
  | { type: 'text';     content: string }
  | { type: 'thinking'; content: string }
  | { type: 'intent';   content: string }
  | { type: 'system';   content: string }
  | { type: 'error';    content: string }

  // Plan panel 內容 — replace-semantics（不進訊息流，由 sticky panel 消費）
  | { type: 'plan'; content: string }

  // 通用 tool — result 內嵌（同 toolUseId 後到的 message 整條 upsert）
  // **`input` 是 provider 預先格式化的單一字串**，不是結構化 object。
  // 詳見「設計選擇 3：tool_use 的 input 是字串而非 object」。
  | {
      type: 'tool_use';
      toolUseId: string;
      toolName: string;
      input: string;
      result?: { content: string; isError?: boolean };
    }

  // 檔案異動 — result 內嵌；diff/content 由 provider 從各 SDK 攤平成統一欄位
  | {
      type: 'file_edit';
      toolUseId: string;
      filePath: string;
      diff?: { oldString: string; newString: string };  // Edit 類
      content?: string;                                  // Write 類（整檔覆寫）
      result?: { success: boolean; error?: string };
    };

// Switch / table key 用的字串 union，從上面 derive 出來，永遠跟著主定義走
export type AgentMessageType = AgentMessage['type'];
```

Renderer 內部訊息陣列另外加一個 `'user'` variant（使用者輸入訊息，不從 provider 來）：

```ts
type RendererMessage = AgentMessage | { type: 'user'; content: string; images?: string[] };
```

每個 type 的 UI 行為：

| type | UI 處理 | 備註 |
|------|---------|------|
| `text` | 訊息流，markdown render，assistant 風格 | provider 來源；user 端對應的是另一個 `'user'` variant |
| `thinking` | 訊息流，dim 折疊區 | 已有 |
| `intent` | 訊息流，單行 dim + ▸ marker | 新加，timeline 保留每次 announce |
| `tool_use` | 訊息流，通用卡片（result 內嵌） | result 缺席=pending，存在=完成 |
| `file_edit` | 訊息流，diff block + filePath（result 內嵌） | result 缺席=pending，存在=✓/✗ |
| `plan` | sticky plan panel（不進訊息流） | replace-semantics（DECISIONS #46） |
| `system` | 訊息流，置中 system 樣式 | 已有 |
| `error` | 訊息流，紅色錯誤樣式 | 已有 |

## 設計選擇 1：為何外部拆 type 而不是內部 kind discriminator

考慮過兩種方案：

**A. 外部拆 type（採用）：** `file_edit` 跟 `tool_use` 是平行的 canonical type
**B. 內部 kind discriminator（拒絕）：** 只有 `tool_use`，內部用 `kind: 'generic' | 'edit'` 分支

選 A 的理由：

- **Union 一覽無遺** — 讀完 `AgentMessageType` 就知道 UI 全部行為類別，不必鑽 payload schema
- **Payload shape 強型別** — 每個 type 有自己 well-defined shape，不需要「if kind X 才有 field Y」的條件 narrowing
- **TS exhaustiveness 自然** — switch on type 漏 case 直接 error；kind 套在內層要多一層 narrowing 才能查
- **避免「行為隱藏在第二層」反模式** — 跟 anti-corruption layer 同精神：外部介面儘量扁平，深層判斷不可見地影響行為很容易踩雷
- **Renderer dispatch 一個 switch 結束** — 看 message.type 就決定要 render 哪個 component，不用先看 type 再進去看 kind 二次分流

## 設計選擇 3：tool_use 的 input 是字串而非 object

第一版 `tool_use` 帶 `toolInput: Record<string, unknown>`，渲染端用 `getToolSummary(toolName, input)` + `ToolBody(toolName, input)` 兩個 helper 各自 switch on toolName 從 input 抽欄位。問題：

- **Renderer 知道太多 SDK 細節** — 對 `Bash` 抽 `command`、對 `Read` 抽 `file_path`、對 `view` 抽 `path`、對 `Grep` 抽 `pattern`…全部寫死在 renderer 裡，每加一個新 SDK tool 要改兩個 switch。
- **case-sensitivity 問題** — Claude 是 `Bash`，Copilot 是 `bash`，renderer 要 `toLowerCase()` 或寫兩條 case，散落在多處。
- **重複顯示** — header summary 跟 body 各自從 input 抽 `command` 字段顯示，bash command 在卡片上出現兩次，純粹是 renderer 兩段邏輯都選擇展示 command 造成的視覺噪音。
- **task 之類複雜 input 退化成 JSON dump** — Copilot `task` tool 的 `input.prompt` 是上百字的自然語句，body 直接 `JSON.stringify` 整個物件變成噪音矩形。

**現行方案：** Provider 翻譯時就把 `toolInput` 攤平成「人能讀的單行字串」`input`，renderer 把它當不透明文字渲染，只做 CSS 截斷。

```ts
{ type: 'tool_use'; toolUseId; toolName; input: string; result? }
```

實作位置：

- Claude: `agent-server/providers/claude.ts:formatClaudeToolInput(toolName, input, cwd)`
- Copilot: `agent-server/providers/copilot.ts:formatCopilotToolInput(toolName, args, cwd)`

兩張表各自 switch on toolName 抽出最該顯示的字段（Bash → command、Read → cwd-relative file_path + 可選 offset/limit、Grep → `pattern in path`、view → cwd-relative path、…），未知 tool 退化到「第一個字串值」或 `JSON.stringify`。

**收益：**

- Renderer 砍掉 `getToolSummary` / `ToolBody`（共 ~70 行），整個 tool_use case 變成「header 顯示 toolName + input（CSS 截斷），expand 後只顯示 result」。
- Header 跟 body 不再各自抽 input，自然消除重複顯示。
- Provider 端負責把 cwd 從絕對路徑剝掉，renderer 不需要知道 cwd（從前 `stripCwd(filePath, cwd)` 在 renderer 跑）。
- 接新 SDK tool 只需在 provider 的 formatter 表加一條，renderer 永遠不動。
- MCP custom tool 自動有 fallback（first string / JSON），不會崩。

**規則：** Tool 渲染需求 == 「input/output 兩塊」→ 用 `tool_use`；任何偏離（檔案編輯有 diff、sub-agent 結果是 markdown、web fetch 顯示 URL preview…）→ 自己一個 canonical type，**不要在 `tool_use` 內部偷偷分流**。

**Persistence backward-compat：** 舊版存的 `tool_use` 帶 structured `toolInput`，新版讀到沒有 `input` 字串時用 `JSON.stringify(toolInput)` 一次性遷移（`src/renderer/storage/agent-history.ts:migrateLegacyToolUseInput`）。歷史 session 仍然顯示得出來，雖然格式醜（純 JSON dump）。新存的訊息直接就是 `input: string`，不會再經過這條路徑。

## 設計選擇 2：Result 內嵌而非獨立 type

考慮過兩種方案：

**A. Result 內嵌（採用）：** `tool_use.result?` / `file_edit.result?` 欄位，後到的 message upsert 同個 `toolUseId` 覆蓋前者
**B. 獨立 result type（拒絕）：** `tool_result` / `file_edit_result` 是獨立 canonical type，selector pre-merge 配對顯示

選 A 的理由：

- **Canonical type 對應「一個 UI 卡片」而非「一條 wire 事件」** — `*_result` 是 wire 細節漏進 canonical 詞彙，內嵌讓概念對齊
- **Switch case 數量更少** — 不必為每個有 result 的 type 各加一條分支
- **Pre-merge selector 變不必要** — store 層 upsert by id 自然處理 pairing
- **Pending state 是免費的** — `result === undefined` 表示 in-flight，不需要另外設 status enum
- **跟 SDK 事件結構同型** — Claude/Copilot 都是 start + complete 雙事件，wire 端 emit 兩次 + 同 id upsert 自然對應

## Wire ↔ Renderer 模型

Wire 端（agent-server → main → renderer）仍是兩個事件：

```
t=0:  { type: 'file_edit', toolUseId: 'X', filePath: '...', diff: {...} }
t=1:  { type: 'file_edit', toolUseId: 'X', filePath: '...', diff: {...}, result: { success: true } }
```

兩條都是同一個 canonical type，只差有沒有 `result` 欄位。Provider 在 SDK `tool.execution_complete` 時補發第二條。

Renderer 端 message store 用 `Map<id, Message>`：

- `tool_use` / `file_edit` 用 `toolUseId` 當 id 做 upsert — 第二條到達時找到同 id 的舊 entry 整條覆蓋
- 沒 `toolUseId` 的 message（text / thinking / intent / system / error）每次都新建一個 entry

渲染時把 store 攤平成陣列照順序 render。switch 只看 type，不需要關心 in-flight 狀態 — payload 的 `result` 有沒有就決定卡片是 pending 還是完成。

## Persistence（IndexedDB）

`saveAgentMessages` / `loadAgentMessages` 行為調整：

- **存什麼：** 攤平後的最終 in-memory 陣列（同個 toolUseId 已經 upsert 完，存最新版）。**不**保留 pending → result 的中間軌跡，那是執行期暫態。
- **何時存：** 維持現有 unmount 時 commit（`saveAgentMessages` on unmount），不必每次 upsert 都打 IDB。
- **載入後：** 直接餵進 store，所有有 toolUseId 的 message 都已是 result 完成態。如果 unmount 時剛好有 pending 進行中，存下來的就是 pending 版本（`result` 缺席）— 重新打開時呈現 pending 卡片但 agent-server 已停，會卡住。**Mitigation：** load 時對「有 toolUseId 但無 result」的 message 補一個 `result: { success: false, error: 'session ended before completion' }`，避免假 pending。

## Switch 與 narrowing 範例

Discriminated union 配 switch 使用，每條 case 內 `msg` 已 narrow 成該 variant 的精準 shape，不需要 optional chaining 跟 type assertion：

```tsx
function AgentMessageView({ msg }: { msg: AgentMessage }) {
  switch (msg.type) {
    case 'text':     return <TextBlock content={msg.content} />;
    case 'thinking': return <ThinkingBlock content={msg.content} />;
    case 'intent':   return <IntentLine content={msg.content} />;
    case 'system':   return <SystemNote content={msg.content} />;
    case 'error':    return <ErrorBlock content={msg.content} />;

    case 'tool_use':
      // msg 已 narrow，msg.toolName / msg.input / msg.result 全部都對。
      // input 是 provider 預先格式化好的字串；renderer 不解析、不抽欄位。
      return <ToolUseCard
        toolName={msg.toolName}
        input={msg.input}
        result={msg.result}
      />;

    case 'file_edit':
      return <FileEditCard
        filePath={msg.filePath}
        diff={msg.diff}
        content={msg.content}
        result={msg.result}
      />;

    case 'plan':
      // 不該在訊息流 render — 上層應該已經被攔截到 sticky panel
      return null;

    default: {
      const _exhaustive: never = msg;
      return null;
    }
  }
}
```

加新 type 不補 case 直接 TS error。改 payload shape（譬如多塞 metadata 欄位）也只動到那個 variant，其他 variant 不受影響。

## 改動範圍

### 1. 抽 canonical type 到 `src/shared/types.ts`

- 新增 `export type AgentMessage` discriminated union（每 variant 自帶該 type 真正需要的欄位）
- 新增 `export type AgentMessageType = AgentMessage['type']`（derive，不重複維護字串 union）
- agent-server 改 import `'../src/shared/types'`（已有先例：`ProviderModel`）
- 移除 `src/main/agent/types.ts` 裡重複的 `AgentMessagePayload`（單一來源）
- Renderer 端 `RendererMessage = AgentMessage | { type: 'user', ... }` extend 加 user variant

### 2. Renderer dispatch 用 switch

由於 `AgentMessage` 是 discriminated union，dispatch 不再需要 mapping table — 直接 switch on `msg.type`，TS exhaustiveness check 用 `_: never` assertion 把關。詳見上面「Switch 與 narrowing 範例」段落。

`plan` 在 dispatch 之前先攔截到 sticky panel：

```ts
function ingestProviderMessage(msg: AgentMessage) {
  if (msg.type === 'plan') {
    setCurrentPlan(msg.content);  // → sticky panel，不進訊息流
    return;
  }
  // 其餘進訊息流
  upsertMessage(msg);
}
```

### 3. Message store 改 upsert by id

renderer 訊息 store 從純 append（`setMessages(prev => [...prev, newMsg])`）改成 upsert：

```ts
function upsertMessage(messages: AgentMsg[], incoming: AgentMsg): AgentMsg[] {
  if (!incoming.toolUseId) return [...messages, incoming];  // 純 append
  const idx = messages.findIndex(m => m.toolUseId === incoming.toolUseId);
  if (idx === -1) return [...messages, incoming];           // 第一次見
  const next = messages.slice();
  next[idx] = incoming;                                      // upsert
  return next;
}
```

含 `toolUseId` 的 message 才走 upsert 路徑；其他維持 append。

### 4. Provider 翻譯層

**`agent-server/providers/claude.ts`：**

- `'plan_update'` → `'plan'`（rename）
- 移除 `'result'` msgType 的發送（dead channel）
- `Edit` / `Write` tool → `file_edit`（normalize args）
  - `Edit`: `{ filePath: input.file_path, diff: { oldString: input.old_string, newString: input.new_string } }`
  - `Write`: `{ filePath: input.file_path, content: input.content }`
  - 對應的 tool result → 同 toolUseId 重發 `file_edit` 帶 `result: { success, error? }`
- 其他 tool 維持 `tool_use` 通用路徑（result 也內嵌）

**`agent-server/providers/copilot.ts`：**

- `'plan_update'` → `'plan'`（rename）
- `report_intent` tool 攔截 → `args.intent`（string）→ `msgType: 'intent'`
  - 跳過對應的 `tool.execution_complete`（同 `task_complete` pattern）
- `task_complete` → `'text'`（已做，欄位是 `args.summary`）
- `apply_patch` tool 攔截 → parse unified-diff string → `file_edit`
  - args 是裸 string（不是 object），格式是 unified diff（`*** Begin Patch` / `*** Update File:` / `*** Add File:` / `@@` / `+/-` 行）
  - 只支援 **單檔 + 單 hunk** 的 Update / Add 情境（涵蓋大多數實際 case）
  - 多檔 / 多 hunk / Delete / parse 失敗 → fallback 成 generic `tool_use`，顯示 raw patch string
  - 對應的 tool execution complete → 同 toolUseId 重發 `file_edit` 帶 `result`
- 其他 tool（`view` / `bash` / 未知）維持 `tool_use` 通用路徑（result 內嵌）
- 移除 `[copilot-task-complete-trace]` / `[copilot-tool-args-trace]` 診斷 log

**Copilot tool inventory（從 trace 確認）：**

| toolName | args 形態 | canonical type 對應 |
|----------|----------|------|
| `report_intent` | `{ intent: string }` | `intent` |
| `view` | `{ path, view_range? }` | `tool_use` |
| `bash` | `{ command, description?, initial_wait? }` | `tool_use` |
| `apply_patch` | 裸 string（unified diff） | `file_edit`（parse 成功）/ `tool_use`（fallback） |
| `task_complete` | `{ summary: string }` | `text`（已做） |

### 5. Renderer 渲染新 type

**`AgentMessage.tsx` 改造：**

- Switch on `message.type` 一個 dispatch 到底
- 漏 case 用 `_exhaustive: never` assertion 強迫窮舉
- 移除既有的 `hasDetailBody` 寫死 toolName 判斷

**`intent`：**

- 單行 dim 字 + ▸ marker
- `global.css` 加 `.agent-intent` class（小字、淡色、左 accent line）

**`tool_use`：**

- 通用卡片 header：toolName + `message.input`（provider 預格式化的字串，CSS 截斷處理超長）
- 展開後 body：**只顯示 result**，不重複印 input（input 已經在 header；展開時 header summary 自動切換到完整不截斷版）
- pending（無 result）：卡片不顯示 result 區塊，header 加 `running` badge
- result 區塊樣式：
  - 30 行內直接 render
  - 超出 30 行截斷 + `... +N more lines`
  - `result.isError === true` 時整個 result 區塊套紅色 `.agent-tool-result-error` 樣式，並強制展開（user 無法縮起來，errors are loud-by-default）
- 不再有獨立 `ToolBody` / `getToolSummary` helper — renderer 不看 toolName、不解析 input

**Provider 端 input formatter（不在 renderer！）：**

- `formatClaudeToolInput(toolName, input, cwd) → string`：Claude SDK 各 tool（Bash/Read/Grep/Glob/Task/WebFetch/...）的 cwd-relative 摘要
- `formatCopilotToolInput(toolName, args, cwd) → string`：Copilot CLI 各 tool（bash/view/grep/glob/list_directory/task/...）對應
- 未知 tool fallback：第一個 string 值 / `JSON.stringify(args)`
- 兩張表分別有單元測試覆蓋（`claude.test.ts` / `copilot.test.ts`）

**`file_edit`：**

- filePath header + diff block (`diff` 用 oldString/newString 對比；`content` 顯示「new file」+ 內容預覽)
- 有 `result` 時：header 加 ✓/✗ indicator，error 時加紅色標示
- pending 期間（無 result）：可選 spinner / dim 樣式

### 6. 命名一致化

詞彙全部統一到 canonical type；不再有「provider 詞彙」/「renderer 內部詞彙」雙軌：

| 原 | 新 | 動的層 |
|----|----|--------|
| renderer 內部 `'assistant'` | 統一改成 canonical `'text'`（assistant 文字） | AgentView.tsx / AgentMessage.tsx |
| provider `'plan_update'` | canonical `'plan'` | claude.ts / copilot.ts / DECISIONS #46 |
| msgType `'result'`（dead） | 刪除 | claude.ts |

User 端訊息保留 `'user'` variant —— 不從 provider 來，本來就跟 canonical 並行。Renderer 視覺上 assistant text vs user text 的差異化由「`type === 'text'` vs `type === 'user'`」分支處理，不需要再做名稱轉換。

## 不在這次範圍

- **OutgoingMessage 第一層 type 重構** — `status` / `stream` / `permission_request` / `error` / `auth_required` 等 wire-level type 不動，這次只解 `type: 'message'` 內層的 msgType 詞彙。
- **Streaming channel** — `type: 'stream'`（streaming text/thinking 用）跟 message channel 平行，buffer 累積邏輯在 renderer 側維持原樣。canonical 詞彙統一只影響 message channel 完成後的 commit message。
- **Plan panel 行為改造** — `plan` 還是維持 replace-semantics + sticky panel，不轉成 timeline 訊息。
- **`intent` sticky 化** — 先做 timeline 單行版（option A）。如果用了一陣子覺得需要 sticky current intent，再開新 issue。
- **Patch protocol 優化** — 重發整條 message 多花一點 bandwidth，目前 message 都很小（< 1KB），不值得做 wire-level diff/patch 優化。

## 待討論細節

1. ~~Tool args 欄位確認~~ — 完成。Copilot 端 `report_intent.intent` / `task_complete.summary` / `apply_patch`（裸 unified-diff string）都已驗證。Claude 端 `Edit` / `Write` toolInput 跟 SDK type def 一致（`file_path` / `old_string` / `new_string` / `content`）
2. `'plan_update'` → `'plan'` 是 breaking rename，要不要保 backward compat（雙寫）一段時間？傾向直接砍乾淨（feature 未外發）
3. `'system'` msgType 現在實際有人發嗎？claude/copilot 都沒主動發，是 ternary fallback 才會用到。要不要乾脆刪掉 canonical 裡的 `'system'`？
4. UI marker 細節：`intent` 用 `▸` 還是 `→` 還是 `※` 還是 dim italic？需要看實際畫面決定
5. `file_edit` 的 diff 渲染要不要支援 large file 折疊（譬如 > 50 行只顯示前後幾行 + 省略 marker）？沿用 git diff 風格還是純色塊？
6. ~~Settings 重構~~ — 完成。`AGENT_DISPLAY_KEYS` 砍剩 4 個 canonical key（`thinking` / `tool_use` / `file_edit` / `intent`），`AgentDisplayKey` 從 `string` 收緊成 union。Migration 走 A1（直接丟棄舊 toolName-keyed 設定）— 舊 JSON 檔殘留的 `Read`/`Bash`/`Edit` 等鍵在 type system 收緊後存取會回 undefined，自然 fall back 到預設 `collapsed`，不需要主動清理。`tool_use` / `file_edit` 加上「錯誤/失敗 override hidden」邏輯：user 設 hidden 時非錯誤訊息照藏，但 `result.isError === true` / `result.success === false` 的卡片強制顯示，避免靜默失敗。

## 影響的檔案

> 這份清單記的是 canonical refactor + tool_use input 簡化兩輪改動的累積結果。第二輪（tool_use input: string）以 ★ 標註。

- `src/shared/types.ts` — 新 `AgentMessage` discriminated union（每 variant 自帶欄位）+ derived `AgentMessageType`；★ `tool_use.toolInput: object` 改為 `tool_use.input: string`
- `src/main/agent/types.ts` — 移除重複 union，import canonical
- `agent-server/providers/types.ts` — `OutgoingMessage` 註解 doc canonical type
- `agent-server/providers/claude.ts` — rename `plan_update` → `plan`、移除 `result`、`Edit`/`Write` 翻譯成 `file_edit` + result upsert、其他 tool 改成 result 內嵌的 `tool_use`；★ 新增 `formatClaudeToolInput()` 把 toolInput 攤平成單一字串，`emitClaudeToolUse` / `emitClaudeToolResult` 全改用 `input: string`，`processMessage` 多收一個 `cwd` 參數傳進 formatter
- `agent-server/providers/copilot.ts` — rename `plan_update` → `plan`、加 `report_intent` → `intent`、`apply_patch` parse + 翻譯成 `file_edit`（parser 限制單檔單 hunk，邊界 case fallback `tool_use`）、其他 tool 改成 result 內嵌的 `tool_use`、移除診斷 log、新增 `workingDirectory` 傳給 Copilot SDK；★ 新增 `formatCopilotToolInput()`，generic tool_use 路徑改用 `input: string`（含 apply_patch 多檔/多 hunk fallback）
- `src/renderer/components/AgentView.tsx` — 移除 ternary mapping（dispatch 改由 AgentMessage.tsx 內 switch 處理）、`plan` sticky 路徑攔截、message store 改 upsert by toolUseId、`'assistant'` 內部詞彙改成 canonical `'text'`；★ `buildAgentMsg` 的 `tool_use` 分支改讀 `msg.input`，對舊版 bundle 殘留的 `toolInput` 做 defensive coerce
- `src/renderer/components/AgentMessage.tsx` — switch 重寫、加 `intent` / `file_edit` render 分支、`tool_use` 改成內嵌 result、移除 `hasDetailBody` 寫死 toolName 判斷；★ 移除 `getToolSummary` / `ToolBody` helper，tool_use case 簡化成「header 顯示 toolName + input、body 只顯示 result」、所有 toolName-keyed settings lookup 統一改成 `resolveDisplayMode('tool_use')`
- `src/renderer/storage/agent-history.ts` — ★ 新增 `migrateLegacyToolUseInput()` load-time 把舊 `toolInput` object 一次性 JSON-stringify 成 `input` 字串
- `src/main/agent/remote.ts` — ★ `buildAgentMessagePayload` 的 `tool_use` 分支改讀 `input: string`，舊 bundle 殘留 `toolInput` 也做 defensive JSON-stringify
- `src/renderer/styles/global.css` — 加 `.agent-intent` / `.agent-file-edit` 樣式、調整 `.agent-tool-use` 內嵌 result 區塊
- `.agent/DECISIONS.md` — #46 更新 `plan_update` → `plan`
- `.agent/PROJECT_MAP.md` — agent-server 描述更新（如果有提到 plan_update / hasDetailBody）

## 估時

實作 2-3 小時，含測試 + 文件更新。風險中（涉及 file edit 渲染翻新 + message store 從 append 改 upsert，需要對齊 Claude/Copilot 兩家 args 欄位）。
