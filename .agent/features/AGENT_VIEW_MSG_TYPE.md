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
  | {
      type: 'tool_use';
      toolUseId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
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
      // msg 已 narrow，msg.toolName / msg.toolInput / msg.result 全部都對
      return <ToolUseCard
        toolName={msg.toolName}
        toolInput={msg.toolInput}
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

- 通用卡片 header：toolName + 摘要（`getToolSummary` 沿用，吃 toolInput）
- pending（無 result）：卡片不顯示 result 區塊，可選 dim / spinner
- result 在卡片同一張，inline 顯示在 header 之下：
  - `result.content` 短（< N 行）直接 render
  - 長（> N 行）折疊 + 「展開全部」trigger（沿用現有 ToolResultCard 折疊邏輯）
  - `result.isError === true` 時整個 result 區塊套紅色 `.agent-tool-result-error` 樣式
- 不再有獨立 ToolResultCard component；既有渲染搬到 ToolUseCard 內 result block

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

## 影響的檔案

- `src/shared/types.ts` — 新 `AgentMessage` discriminated union（每 variant 自帶欄位）+ derived `AgentMessageType`
- `src/main/agent/types.ts` — 移除重複 union，import canonical
- `agent-server/providers/types.ts` — `OutgoingMessage` 註解 doc canonical type
- `agent-server/providers/claude.ts` — rename `plan_update` → `plan`、移除 `result`、`Edit`/`Write` 翻譯成 `file_edit` + result upsert、其他 tool 改成 result 內嵌的 `tool_use`
- `agent-server/providers/copilot.ts` — rename `plan_update` → `plan`、加 `report_intent` → `intent`、`apply_patch` parse + 翻譯成 `file_edit`（parser 限制單檔單 hunk，邊界 case fallback `tool_use`）、其他 tool 改成 result 內嵌的 `tool_use`、移除診斷 log
- `src/renderer/components/AgentView.tsx` — 移除 ternary mapping（dispatch 改由 AgentMessage.tsx 內 switch 處理）、`plan` sticky 路徑攔截、message store 改 upsert by toolUseId、`'assistant'` 內部詞彙改成 canonical `'text'`
- `src/renderer/components/AgentMessage.tsx` — switch 重寫、加 `intent` / `file_edit` render 分支、`tool_use` 改成內嵌 result、移除 `hasDetailBody` 寫死 toolName 判斷
- `src/renderer/styles/global.css` — 加 `.agent-intent` / `.agent-file-edit` 樣式、調整 `.agent-tool-use` 內嵌 result 區塊
- `.agent/DECISIONS.md` — #46 更新 `plan_update` → `plan`
- `.agent/PROJECT_MAP.md` — agent-server 描述更新（如果有提到 plan_update / hasDetailBody）

## 估時

實作 2-3 小時，含測試 + 文件更新。風險中（涉及 file edit 渲染翻新 + message store 從 append 改 upsert，需要對齊 Claude/Copilot 兩家 args 欄位）。
