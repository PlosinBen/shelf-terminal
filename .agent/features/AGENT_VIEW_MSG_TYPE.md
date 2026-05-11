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
3. ~~`'system'` msgType 現在實際有人發嗎？~~ — 保留。盤點下來 provider wire 端確實沒人發，但 renderer 端會主動建 `system` 訊息插進 timeline，用途包括：
   - Model switch 通知（`── Model switched to Opus ──`）
   - `/clear` 後的 context-cleared 通知
   - `/help` / `/context` 等 slash command 的 `system-message` 結果包裝
   結論：`system` 是「user-facing 的中性通知 type」，不是 error 也不是 assistant text。Provider wire 端理論上能 emit（保留入口給未來 session-level warning），但目前實際只走 renderer 端。`buildAgentMessagePayload` 的 `system` case 是 defensive 預留，可視為文件型 dead code。
4. UI marker 細節：`intent` 用 `▸` 還是 `→` 還是 `※` 還是 dim italic？需要看實際畫面決定 — 暫緩，Copilot 實務上 `report_intent` 呼叫頻率偏低，沒實際畫面可以校準。等有累積觀察再回來調 marker / spacing / 顏色
5. ~~`file_edit` 的 diff 渲染要不要支援 large file 折疊？~~ — 暫不做。`SideBySideDiff` 目前不截斷、`InlineAddDiff` 截 20 行；實務上 agent 改檔案多在 20 行內，沒實際觸發痛點。折疊是純 renderer 議題（wire 資料保留完整 diff/content），未來真的痛了再加。要做就走線性截斷 + 點擊展開（Option B）；git-diff 風格智能折疊（Option C）過度設計，本工具不是 code review viewer
7. ~~`task` / `Agent` 結果改 markdown render？~~ — 不做。tool_use 的核心原則是「renderer 不看 toolName、特殊渲染 = 獨立 canonical type」，回去在 tool_use 內依 toolName 切渲染策略違反這條。Markdown table 在 `<pre>` 下不漂亮但 readable，data 沒丟。User 立場：看 agent 訊息是要追「它實際呼了哪些 tool」，不是讀它的散文摘要 — task 結果本來就不是 UI 焦點。
   如未來真的痛了，正解是把 `Task` / `Agent` / Copilot `task` 升格成獨立 canonical type（暫名 `tool_task`），renderer 寫專屬 component 做 markdown render + sub-agent type badge + collapsable prompt。**不要回去 tool_use 內加 toolName-sniff 的特殊路徑。**
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

---

# 第二輪：P1 + P2 架構級重構（IPC turn-id routing + Streaming channel 統一）

> 這個 section 是 canonical refactor 跑了一段時間之後的下一階段，記錄 wire protocol 跟 streaming pipeline 的徹底重構計畫。內容以「分階段 + 每階段有 checkpoint」方式組織，**做到一半中斷可以回來照節點繼續**。

## 決策紀錄（動工前對齊）

| # | 議題 | 決策 | 影響 |
|---|------|------|------|
| 1 | `msgId` / `toolUseId` 合併或並存 | **合併** — toolUseId 概念升級為 msgId（universal id）。Tool message 上 `msgId === toolUseId`。permission_request wire 仍用 `toolUseId` 欄位（語意更明確），但值是同一個 | Phase 2.1 / 2.2 / 3.1 都照「合併」走 |
| 2 | 重構完之後 `dedupSend` 去留 | **拿掉** — turn-dispatcher 上線後 dedupSend 變多餘，留著反而誤導。重構同時清理 claude.ts，回歸自然 emit 兩次 idle（main 端按 turnId 各自路由不影響） | Phase 2.3 改成「移除 dedupSend」而非「決策」 |
| 3 | Persistence: streaming 進行中的訊息要不要寫 IDB | **不存** — `saveAgentMessages` 寫入前 filter 掉 `streaming: true` 的 entry。中斷的 turn 不留半截。對齊現有 `reviveOrphanPending` 對 pending tool_use 的精神但更乾淨 | Phase 3.1 加 filter |
| 4 | Wire schema 收緊範圍 | **all-in** — 一次把所有 wire event（lifecycle / control / message / stream）都 discriminated union 化，砍掉 `[key: string]: unknown` 兜底 | Phase 1.2 範圍擴大到全部 type |
| 5 | turnId 格式 | `t-${crypto.randomUUID().slice(0, 8)}` — 8 hex chars 夠用，agent-server 程序壽命內不會撞 | Phase 1.1 |
| 6 | Block id 來源 | **Provider 自己維護 per-turn counter**，不依賴 SDK 提供的 block_index。形式 `${turnId}:b${n++}`。Claude/Copilot 兩邊各自跑 counter，從 stream 第一個 chunk / message 第一條開始遞增 | Phase 2.1 |

## 為什麼 P1 + P2 綁一起做

P1（turn-id routing）跟 P2（streaming channel 統一）都動到同一層：wire protocol envelope + main/renderer 的 IPC handling。如果分兩波做：
- 第一波 P1 要先建臨時相容層讓 stream channel 認新的 envelope 欄位
- 第二波 P2 再拆臨時層

綁一起做：一次重建 wire schema + IPC dispatcher + renderer state pipeline，新 schema 一步到位，沒有過渡期 dead code。

## 目前現況 baseline（重構前的事實）

### Wire protocol（agent-server → main）

`agent-server/providers/types.ts:27-37` 的 `OutgoingMessage` 是 free-form union：
```ts
export type OutgoingMessage = {
  type: 'message' | 'stream' | 'status' | 'error' | 'pong' | 'ready' | 'capabilities'
      | 'auth_required' | 'permission_request' | 'credential_stored' | 'credential_cleared'
      | 'slash_result' | 'context_patch';
  [key: string]: unknown;  // ← payload free-form
};
```

每條 wire 事件就是一行 JSON。**沒有 envelope 欄位**（沒有 turnId / sessionId / requestId 之類能標識「這事件屬於哪個 query turn」的 id）。

### Main 端 IPC reader（`src/main/agent/remote.ts`）

- `RemoteProcess.onLine(callback)` 是 setter（line 326-328），每次呼叫**覆寫**前一次的 `lineHandler`
- 每個 `query()` 呼叫產生一個新的 `streamRemoteEvents` async generator，generator 開頭 `remote.onLine(...)` 設置自己的 callback（line 362-374）
- Callback 累積到 local `events[]`，看到 `state: 'idle'` 就 `done = true`，generator 結束
- 結果：**前一個 turn 的 lineHandler 被新 turn 覆寫**，跨 turn 殘留事件被新 turn 的 handler 吃掉（這次 queue msg bug 的根因）

### Renderer 端 stream 處理（`src/renderer/components/AgentView.tsx`）

雙 state 緩衝區：
- `streamText: string` (line 132) — 累積 `type: 'stream'` 的文字 chunks
- `streamThinking: string` (line 133) — 累積 thinking chunks
- `messages: AgentMsg[]` (line 128) — 已完成的訊息陣列

三條對齊邏輯（散在 `onStream` / `onMessage` / `onStatus` 三個 listener）：

1. **`onStream`** (line 391-400 上下)：`setStreamText(prev => prev + chunk.content)` — 累積增量
2. **`onMessage`(msgType=text)** (line 373-376)：`setStreamText('')` + push assembled block 進 messages — 完整 block 到了，清緩衝、推進 timeline
3. **`onStatus` streaming→idle transition** (line 397-432)：if `streamText.trim()` 非空，promote 為 `messages` 的 text entry，清空緩衝 — turn 結束時兜底，把還沒被 onMessage 覆蓋的緩衝沖進去

UI 渲染：
- `streamText` 只在 `isLastTurn` 且 isStreaming 時顯示，帶 cursor（line 895-928 上下）
- `messages` 永遠按序渲染

**雙 state 是 race source**：上次 queue msg bug 就是 `setStreamText('')` / promote 時序錯亂。Renderer flush 既要清 streamText（避免 turn 2 從 turn 1 殘留累積）又要等 turn 2 的 stream chunks，邏輯散落容易踩坑。

### 目前 Provider 端發兩種 wire 事件

每個 text/thinking block 走兩條 channel：

- `stream` event（increment）：`{ type: 'stream', streamType: 'text'|'thinking', content: delta }`
- `message` event（finalize）：`{ type: 'message', msgType: 'text'|'thinking', content: fullBlock }`

Claude SDK 跟 Copilot CLI 都遵守這個 pattern（agent-server/providers/claude.ts:657-659 / 605-607、copilot.ts:459-474）。

---

## 目標終態（重構後的事實）

### 1. 每個 wire event 帶 envelope

新增 envelope 欄位 `turnId: string` — 由 agent-server 在每個 `handleSend(msg)` 開頭生成一次，wrap `send` 自動注入。

```ts
// before
{ type: 'message', msgType: 'text', content: '...' }
// after
{ type: 'message', turnId: 't-1234', msgType: 'text', content: '...' }
```

例外：lifecycle events（`ready` / `pong` / `capabilities`）跟 query turn 無關，沒有 turnId 是預期的。

### 2. Main 端 turn-dispatcher

`remote.ts` 改架構：
- **單一全域 `onLine` listener** 在 RemoteProcess 建立時掛上一次，永遠不被覆寫
- Listener 依 `turnId` 把 event 丟進對應 turn 的 queue
- `query()` 開始時註冊一個 turnId → 拿到一個只看自己 turn 的 AsyncIterator
- 沒有 matched turnId 的 event（lifecycle 之外的殘留）→ log warning + drop（不會像目前漏進下個 turn）

```ts
interface RemoteProcess {
  registerTurn(turnId: string): AsyncIterator<AgentEvent>;
  // onLine setter 拿掉，改成內部全域 dispatcher
}
```

### 3. Streaming + message 合進單一 upsert pipeline

每個內容區塊（text block / thinking block）由 provider 賦予 `msgId: string`（per-turn, per-block stable），wire 事件改成：

```ts
// stream chunk (incremental update)
{ type: 'stream', turnId, msgId, channel: 'text'|'thinking', delta: '...' }
// finalize (full block ready)
{ type: 'message', turnId, msgId, msgType: 'text'|'thinking', content: '...' }
```

Renderer 收到後**都進同一個 `messages` store**，按 `msgId` upsert：
- stream chunk：找 msgId 對應 entry，append delta；不存在就用 delta 新建
- finalize：找 msgId，覆蓋 content（完整版蓋掉累積版）；不存在就直接新建
- 加上 `streaming?: boolean` flag 標記是否還在增量

`streamText` / `streamThinking` 兩個 renderer state 拆掉。UI 渲染只看 `messages`。Streaming cursor 改成「if message.streaming → 末端加 cursor span」。

### 4. tool_use / file_edit 的 result 內嵌維持原樣

這兩條本來就 upsert by `toolUseId`，等同於 `msgId`。重構後 toolUseId 就是 msgId 的一種。不用特別改 schema，只是統一進 `msg.msgId` 欄位（或保留 `toolUseId` 別名，看實作偏好）。

---

## Wire schema 完整定義（重構後）

```ts
// agent-server/providers/types.ts

interface WireEnvelope {
  turnId?: string;  // 缺席 = lifecycle event（ready/pong/capabilities）
}

type OutgoingMessage = WireEnvelope & (
  // Message channel — finalize
  | { type: 'message'; msgId: string; msgType: 'text' | 'thinking' | 'intent' | 'system' | 'error' | 'plan'; content: string }
  | { type: 'message'; msgId: string; msgType: 'tool_use'; toolName: string; input: string; result?: {...} }
  | { type: 'message'; msgId: string; msgType: 'file_edit'; filePath: string; diff?: {...}; content?: string; result?: {...} }

  // Stream channel — incremental
  | { type: 'stream'; msgId: string; channel: 'text' | 'thinking'; delta: string }

  // Status / control（per turn）
  | { type: 'status'; state: 'streaming' | 'idle'; ... }
  | { type: 'permission_request'; toolUseId: string; ... }
  | { type: 'error'; error: string }
  | { type: 'context_patch'; patch: PersistedContext }

  // Lifecycle（no turnId）
  | { type: 'ready' }
  | { type: 'pong' }
  | { type: 'capabilities'; ... }
  | { type: 'auth_required'; provider: string }
);
```

Discriminated union 化，不再 `[key: string]: unknown` 兜底。

---

## 實作步驟與 Checkpoints

> 每個步驟結尾有「驗證指令 + 預期結果」，中斷後從這裡接續。

### Phase 1：Wire envelope + turn dispatcher（P1 主體）

#### Step 1.1 — agent-server 加 turnId 注入

**檔案：** `agent-server/index.ts`、`agent-server/orchestrator.ts`

- 在 `handleSend(msg)` 開頭 `const turnId = 't-' + crypto.randomUUID().slice(0, 8)`（決策 #5）
- 將 `send: SendFn` wrap 成 `turnAwareSend: (m) => send({ ...m, turnId })`
- 把 wrapped send 傳進 `backend.query(input, turnAwareSend)`
- Provider 端不用動（直接收到帶 turnId 的 send）

**Checkpoint：**
```bash
npm run typecheck && npm run test:unit
```
新增 unit test：mock send 收到的 msg 都帶 turnId（單 handleSend）；不同 handleSend 用不同 turnId。

#### Step 1.2 — OutgoingMessage 全面 discriminated union（all wire events）

**檔案：** `agent-server/providers/types.ts`

依決策 #4，所有 wire event 一次清乾淨：

- `OutgoingMessage` 拆成完整 discriminated union（見上面「Wire schema 完整定義」），含 lifecycle (`ready`/`pong`/`capabilities`/`auth_required`)、control (`status`/`error`/`permission_request`/`context_patch`/`credential_*`/`slash_result`)、message、stream 全部
- 拿掉 `[key: string]: unknown` 兜底
- 把目前散落在 provider 各處的 ad-hoc 欄位收進對應 variant 的明確 shape
- 修 provider 端 type 錯誤（這步可能有零星 cast，是好事，迫使我們明確每個 emit shape）

**注意：** lifecycle 三個（`ready` / `pong` / `capabilities`）依然沒 turnId。type 上用 `WireEnvelope` interface 把 turnId 標為 optional，但其他所有 type 在文件上註明「必須帶 turnId」。

**Checkpoint：**
```bash
npm run typecheck
```
TS 應該爆出所有 ad-hoc 欄位的 send，逐一修。修完 0 error。

#### Step 1.3 — main 端 RemoteProcess turn-dispatcher 改造

**檔案：** `src/main/agent/remote.ts`

- `RemoteProcess` interface：拿掉 `onLine`，加 `registerTurn(turnId: string): AsyncGenerator<AgentEvent>`
- 內部維護 `Map<turnId, { queue: AgentEvent[], resolve?: () => void, done: boolean }>`
- 單一 stdout 'data' parser 在 spawn 時就掛上，按 `parsed.turnId` 路由到對應 queue
- 沒 turnId 的 lifecycle event 走獨立 channel（`waitForReady` / 設定查詢用）
- 沒 matched turnId（殘留事件）→ `log.warn` + drop
- `query()` 改用 `proc.registerTurn(turnId)` 拿 AsyncIterator

**注意：**
- `parseRemoteMessage` 邏輯保留（純 schema parsing），只是 routing 上移到 RemoteProcess 內部
- 跟 stdin write 的 `proc.sendLine({ type: 'send', ... })` 要在 `registerTurn` **之前**呼叫，避免 race（先註冊 listener 再送）

**Checkpoint：**
```bash
npm run typecheck && npm run test:unit
```
新增 unit test：
1. 兩個 turn 連續 register，event 帶不同 turnId，各自只收到自己的
2. Event 帶不認得的 turnId → drop + warn
3. Lifecycle event（無 turnId）正常走 ready/capabilities 流程

#### Step 1.4 — Renderer 不變，但 e2e 驗證 cross-turn race 已修

這時 P1 主體完成。`dedupSend` 還在 — 留著當第二層防護。理論上即使 provider 規矩走、idle 各種發都不會踩坑了，但 dedupSend 的成本很低，留著當 belt-and-suspenders。

**Checkpoint（e2e 場景重現 queue msg）：**
- 開 packaged app（重打包後）
- Streaming 中送 queued msg
- 驗證：turn 1 idle 後，turn 2 user bubble 出現、agent 回應正常出來
- Log 不應該出現 `dropped event for unknown turnId`（如果出現代表 provider 還有跨 turn emit，需要追）

---

### Phase 2：Stream channel 統一（P2 主體）

#### Step 2.1 — Wire schema 加 msgId（合併 toolUseId）

**檔案：** `agent-server/providers/types.ts`、Claude/Copilot provider

依決策 #1，msgId 是 universal id：
- 所有 `message` variant 帶 `msgId: string`（取代或統一 toolUseId 作為 upsert key）
- Tool message 上 `msgId === toolUseId`（語意：tool 卡片的 id 就是 toolUseId）
- `permission_request` wire event 仍用 `toolUseId` 欄位名（語意更明確）— 對應的 tool message 的 msgId 跟它同值
- `stream` variant 也帶 `msgId`，跟對應 finalize message 的 msgId 相同

依決策 #6，Provider 自己維護 per-turn counter 生 block id：
- Claude provider：在 query() 入口宣告 `let blockCounter = 0`，每次新 block 開始（content_block_start）`const msgId = \`${turnId}:b${blockCounter++}\``，stream chunks 跟 finalize 共用
- Copilot provider：對應的 block-start 事件做一樣的事
- Tool block 也走同套 counter（但 msgId === toolUseId 是 tool 的特例 — 不過實務上 tool block 的 msgId 直接用 toolUseId 就好，不用透過 counter，因為 SDK 給的 toolUseId 已經 stable 且 unique）

```ts
// 在 claude.ts query() 大致長這樣
let blockCounter = 0;
const nextMsgId = () => `${turnId}:b${blockCounter++}`;
// text/thinking block
const blockMsgId = nextMsgId();
send({ type: 'stream', msgId: blockMsgId, channel: 'text', delta: '...' });
// ... more deltas ...
send({ type: 'message', msgId: blockMsgId, msgType: 'text', content: '...full' });
// tool block — 用 toolUseId 直接
send({ type: 'message', msgId: toolUseId, msgType: 'tool_use', toolName, input, ... });
```

**Checkpoint：**
```bash
npm run typecheck && npm run test:unit
```
Provider 端的 emit 測試覆蓋：
- 同一個 block 多個 stream chunk 共用 msgId
- finalize message 跟對應 stream 共用 msgId
- Tool message 的 msgId === toolUseId
- 不同 block 用不同 msgId（counter 遞增）

#### Step 2.2 — Renderer message store 改 upsert

**檔案：** `src/renderer/components/AgentView.tsx`

- 拿掉 `streamText` / `streamThinking` state
- Renderer-side `AgentMsg` type 加 `streaming?: boolean` flag
- `onStream(chunk)`：找 `messages` 內 msgId 對應 entry，append delta；不存在就新建 `{ type: chunk.channel, msgId, content: delta, streaming: true }`
- `onMessage(msg)`：找 msgId 對應 entry，覆蓋 content + 設 `streaming: false`；不存在就新建
- `onStatus(idle)`：把所有還 `streaming: true` 的 entry 設成 `streaming: false`（兜底）
- UI 渲染：刪掉 `showStreamText` / `streamThinking` 那一塊，所有訊息一律從 `messages` 渲染
- Streaming cursor：`<AgentMessage>` 內部 if `msg.type === 'text' && msg.streaming` → 末端加 cursor span

**注意：**
- `tool_use` / `file_edit` 的 upsert key 從 `toolUseId` 統一到 `msgId`（toolUseId 改名或加 alias）
- queue flush useEffect 不需要 `setStreamText('')` 了（streamText 沒了）

**Checkpoint：**
```bash
npm run typecheck && npm run test:unit
```
Component test：
- 連續 stream chunks 累積到同一個 msg
- finalize 覆蓋累積值
- 多 block 同 turn 各自獨立累積
- idle 後所有 streaming flag 都 false

**e2e（手動）：**
- 開 packaged app，跑一輪正常對話
- 視覺確認 streaming cursor 還在、字一個個出來的觀感不變
- 跟 baseline 比對：streaming 中途送 queued msg → 還是正常

#### Step 2.3 — 移除 dedupSend

依決策 #2，turn-dispatcher 上線後 dedupSend 變多餘 → 拿掉。

**檔案：** `agent-server/providers/claude.ts`

- 移除 `dedupSend` wrapper（query() 開頭那段 closure）
- query 內所有 `dedupSend(...)` 改回 `send(...)`
- 補一條 comment：「Per-turn idle dedup 由 main 端 turn-dispatcher 處理，provider 自然 emit 即可」

**Checkpoint：**
```bash
npm run typecheck && npm run test:unit
```
跑一次 queue msg scenario e2e：turn 1 emit 兩次 idle（result handler + finally），main 端 turn-dispatcher 各自帶 turnId，第一個 idle 結束 turn 1 iterator，第二個 idle 帶同 turnId 找不到接收者（已 unregister）→ log warn + drop。Turn 2 不受影響。

---

### Phase 3：清理與收尾

#### Step 3.1 — Persistence schema 兼容 + streaming filter

**檔案：** `src/renderer/storage/agent-history.ts`

依決策 #1（合併 msgId / toolUseId）：load 時把舊 `toolUseId` 補成 `msgId`：
```ts
if (msg.toolUseId && !msg.msgId) {
  msg.msgId = msg.toolUseId;
}
```

依決策 #3（不存 streaming 中的訊息）：`saveAgentMessages` 寫入前 filter：
```ts
export async function saveAgentMessages(sessionId, messages, maxMessages = DEFAULT_MAX_MESSAGES) {
  // Drop in-flight streaming entries — they have no final content yet, and
  // letting them persist would either show a zombie "still typing" UI on
  // reload (agent-server is dead) or require synthetic finalization that
  // shows incomplete content. Cleanest: just drop. Tool/file_edit pending
  // entries are different — they're concrete actions that did fire, so
  // reviveOrphanPending synthesizes a failed result. Text/thinking
  // streaming is mid-utterance and has nothing meaningful to preserve.
  const filtered = messages.filter((m) => !((m as any).streaming));
  // ... existing trim/rotate logic on `filtered` ...
}
```

`reviveOrphanPending` 維持原樣（只動 tool_use / file_edit 的 pending state）。

#### Step 3.2 — GOTCHAS 更新

把 GOTCHAS 裡「Queued message flush — claude provider 每 turn 只能發一次 `state: 'idle'`」這條更新（依決策 #2，dedupSend 已拿掉）：
- 標註「P1 turn-dispatcher 上線後，跨 turn idle leak 由 turnId routing 在 main 端攔截 → 不會誤入下個 turn iterator。Provider 自然 emit 兩次 idle 沒問題，第二次帶同 turnId 但對應 iterator 已 unregister，被 log warn + drop」
- 移除原本的 dedupSend 內容（已不存在）

#### Step 3.3 — DECISIONS 新增

新增一條 DECISION：
> #N — Wire protocol 帶 turnId envelope，main 端按 turnId 路由
>
> Rationale: 解決 single-lineHandler 跨 turn event leak（見 GOTCHAS 該條）。Per-event sessionId/requestId 提供 protocol-level 隔離，未來新 provider / 新事件類型都不會踩同坑。
>
> Trade-off: 每個 event payload 多 ~30 bytes（turnId UUID）；對目前 event throughput（< 1000/turn）無感。

#### Step 3.4 — PROJECT_MAP 更新

- `remote.ts` 條目更新：single-lineHandler → turn-dispatcher
- `AgentView.tsx` 條目更新：streamText/streamThinking → unified messages store with streaming flag

---

## 風險與緩解

| 風險 | 緩解 |
|------|------|
| **Streaming UX 退化**（cursor 跳動、字出現不順暢） | Phase 2.2 完成後手動 e2e 驗證，跟 baseline 並排比對。preview build 而非 dist 給自己用一週 |
| **msgId 設計撞 toolUseId** | Phase 2.1 確認 toolUseId 是否合併進 msgId 還是並存。建議合併（toolUseId rename 為 msgId）— 概念上是同一個東西 |
| **Provider 端 block-index 不穩**（SDK 沒給可靠 block id） | Fallback：用 `${turnId}:${incrementCounter++}` 在 provider 端維護 per-turn counter |
| **Phase 1.3 (turn-dispatcher) 改錯導致整個 agent 不通** | Phase 1.3 跟 1.4 之間有完整 e2e checkpoint。1.3 失敗就 rollback，wire schema 改動量小（只加 turnId 欄位），rollback 成本低 |
| **Phase 2.2 改 streamText/streamThinking 引入 regression** | 改前在 1.4 baseline 跑一輪 sanity test 影片留底，改後逐項比對 |

---

## 估時

- Phase 1：2 天（Step 1.1-1.4，含 unit test + e2e 驗證）
- Phase 2：3 天（Step 2.1-2.3，含 streaming UX 微調）
- Phase 3：0.5 天（文件 + 清理）
- **總計：~5-6 天 focused 工作**

## 不在這次範圍（仍延後）

- **Plan panel 行為改造**（replace-semantics + sticky panel 維持）
- **`intent` sticky 化**
- **Patch protocol wire-level diff 優化**（message 都 < 1KB，無痛點）

## 進度追蹤

> 每完成一個 Step，把 `[ ]` 改成 `[x]`，附 commit hash。中斷時看最後一個 `[x]` 接續。

- [x] Step 1.1 — agent-server 加 turnId 注入 (`b8e1c88`)
- [x] Step 1.2 — OutgoingMessage 加 envelope type (`5047c68`)
- [x] Step 1.3 — main 端 RemoteProcess turn-dispatcher 改造 (`54ff655`)
- [ ] Step 1.4 — Phase 1 e2e 驗證（queue msg cross-turn 場景不再踩 idle race）
- [x] Step 2.1 — Wire schema 加 msgId（provider 端生 block-stable id）(`2fc4e44`)
- [x] Step 2.2 — Renderer message store upsert 化 + 拿掉 streamText/streamThinking (`3e5b9e1`)
- [x] Step 2.3 — 移除 dedupSend（依決策 #2）(`16e2bd7`)
- [x] Step 3.1 — Persistence schema 兼容 (`9b86f3c`)
- [x] Step 3.2 — GOTCHAS 更新 (`3e3a1f5`)
- [x] Step 3.3 — DECISIONS 新增 (`3e3a1f5`)
- [x] Step 3.4 — PROJECT_MAP 更新 (`3e3a1f5`)
