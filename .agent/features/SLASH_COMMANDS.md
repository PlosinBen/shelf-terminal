# Slash Commands Architecture

## 問題

目前 slash command 處理散落且 provider 之間行為不一致：

- **Claude**：SDK 原生支援 `/compact`、`/clear`、`/model` 等，但我們會在 renderer 攔截 `/model`，反而蓋過 SDK 行為
- **Copilot**：`slashCommands: []`，`/model` 因為 renderer 寫死才能用，`/clear`、`/compact`、`/help` 都打不出來
- **`/model`**：寫死在 `AgentView.tsx`（純前端改 UI state），沒宣告在任何 slashCommands 裡，發現性差
- **Future provider**（user-configured baseURL、本地 LLM）：每家能力不同（model list 動態 vs 靜態、是否支援 tool use 等），現有架構難擴展

不合理的地方：renderer 對 provider 內部行為知道太多。

## 設計目標

1. Renderer 對 provider 無知 — 用統一介面打 slash command
2. Provider 自行決定怎麼處理（pass-through to SDK / 自己做 / 開 UI picker / 系統訊息）
3. Auth 失敗一律走既有 `auth_required` 流程，不為 slash 多寫 fallback
4. Model list 來源差異（Claude 寫死、Copilot 抓 API、user 自填）由 provider 內部封裝

## 介面

### Provider 端

```ts
interface ServerBackend {
  // 既有
  query(input, send): Promise<void>
  gatherCapabilities(cwd): Promise<ProviderCapabilities>

  // 新增
  handleSlashCommand(cmd: string, args: string): Promise<SlashResult>
}

interface ProviderCapabilities {
  currentModel: string
  models: Model[]              // init 時抓一次（Copilot 從 API、Claude 寫死、未來 provider 從 user config）
  slashCommands: SlashCommandDef[]  // 該 provider 支援的指令
  permissionModes: string[]
  effortLevels: string[]
  authMethod: AuthMethod
}

interface SlashCommandDef {
  name: string         // 不含 / 前綴
  description: string  // menu 顯示用
}

type SlashResult =
  | { type: 'show-model-picker'; models: Model[]; current: string }
  | { type: 'switch-model'; model: string }
  | { type: 'context-cleared'; message?: string }
  | { type: 'pass-through' }                    // 例如 Claude 的 /compact，讓 SDK 接手
  | { type: 'system-message'; content: string } // 例如 /help 列指令清單
  | { type: 'error'; message: string }          // unknown model 等
```

### Renderer 端

```ts
// 1. 打 / 觸發 menu：用 capabilities.slashCommands
// 2. 送出時先攔截，IPC 給 provider 處理

const result = await window.shelfApi.agent.slashCommand(tabId, cmd, args)

switch (result.type) {
  case 'show-model-picker':
    setModelList(result.models)        // 更新 cache（status bar 也用同一份）
    setModelPicker({ open: true, current: result.current })
    break
  case 'switch-model':
    // 樂觀更新：直接設 UI state + setPrefs
    setStatusModel(result.model)
    window.shelfApi.agent.setPrefs(tabId, { model: result.model })
    break
  case 'context-cleared':
    setMessages((prev) => [...prev, { type: 'system', content: result.message ?? '── Context cleared ──' }])
    break
  case 'pass-through':
    // 照常送 message（讓 SDK 接手）
    sendMessage(text)
    break
  case 'system-message':
    setMessages((prev) => [...prev, { type: 'system', content: result.content }])
    break
  case 'error':
    setMessages((prev) => [...prev, { type: 'error', content: result.message }])
    break
}
```

## 各 Provider 預期行為

| 指令 | Claude | Copilot | Future generic OpenAI |
|------|--------|---------|----------------------|
| `/model`（無參數）| `show-model-picker` (寫死 list) | `show-model-picker` (重抓 API) | `show-model-picker` (用 user-configured list) |
| `/model x` | `switch-model` | `switch-model` | `switch-model` |
| `/clear` | `pass-through`（SDK reset session）| `context-cleared`（清 modelMessages，保留 system prompt） | 同 Copilot |
| `/compact` | `pass-through`（SDK 自己壓）| `system-message`（手動觸發後現有 auto-compact 邏輯）| 同 Copilot |
| `/help` | `system-message`（列 SDK 提供的 commands）| `system-message`（列前述 4 個）| 同 Copilot |
| `/context` | `pass-through` | `system-message`（顯示 token usage）| 同 Copilot |
| Unknown | `error` | `error` | `error` |

注意：Claude 的 `slashCommands` 從 SDK cache 動態取，所以 menu 會跟 Claude CLI 一致。Copilot 的是 hard-coded 在 provider 裡。

## Model List 生命週期

1. **Init**：`gatherCapabilities()` 抓一次，client cache
2. **`/model` invocation**：provider 重抓，透過 `show-model-picker` SlashResult 回傳新 list，client **替換** cache
3. **Status bar dropdown click**：用 cache（可能是 init 或上次 `/model` 的，user 想 refresh 就打 `/model`）
4. **User-configured provider（未來）**：`gatherCapabilities()` 直接回 user 設定的 list；`/model` 不重抓（沒地方抓）

## Auth 失敗處理

任何 provider 操作（init / query / handleSlashCommand）token 失效 → emit `auth_required` event，走既有流程。Slash command 不另外做 fallback。例如 Copilot `/model` 抓 list 時 token 過期 → 觸發 `auth_required`，user 重認證後可重打 `/model`。

## 樂觀更新

`switch-model` 採樂觀更新：renderer 收到後立刻改 UI state + `setPrefs`，不等 backend 確認。下次 query 才會用新 model，那時若有錯誤會走正常的 query error path。

## IPC 新增

- `agent.slashCommand(tabId, cmd, args)` → `Promise<SlashResult>`

Renderer → main process → agent-server。Stdin/stdout JSON line 加新 message type `slash_command` / `slash_result`。

## 移除

- `AgentView.tsx` 裡寫死的 `/model` 攔截邏輯（line 317-342）— 改走統一管道
- `capabilities.slashCommands` 在 Copilot 從 `[]` 改成有值

## 不在這次 scope

- User-configured generic OpenAI provider（介面預留，實作之後）
- `/clear` 在 UI 層的 message history 清除（user 用右鍵選單，不走 slash）
- `/compact` 手動觸發在 Copilot 的具體實作（auto-compact 已存在）

## 開放問題

- Claude SDK 的 slash command 是否真的有 `/model`？需要實測 SDK 行為。如果有，Claude `/model` 應該 `pass-through`，反之 `show-model-picker`。
- `pass-through` 的具體行為：是 renderer 把原字串當 user message 送，還是 backend 自己接手？目前傾向 renderer 送（保持 query 入口統一）。
