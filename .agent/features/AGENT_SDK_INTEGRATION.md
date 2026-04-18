# Agent SDK Integration — Architecture Plan

## Overview

在 Shelf Terminal 中整合 AI agent 對話功能，支援多 provider（Claude Code、Copilot、Gemini），以專屬 agent tab 呈現結構化對話 UI。

### 來源

功能移植自三個 refer 專案：
- `agent-terminal` (v0.3.3) — 原始 SDK 整合
- `better-agent-terminal` (v2.1.1) — 最成熟的實作（session 持久化、subagent 追蹤、stall detection）
- `agent-terminal-copilot` (v0.2.4) — 多 provider 抽象層

### 當初廢棄原因

SDK 的 quota 耗損問題（API call 消耗大量 token），因此轉向純 terminal 管理方案。目前回報 quota 問題已改善，重新評估整合。

---

## Core Decisions

### D1. Agent Tab 是 Project 內的 Tab Type

Agent 對話與 terminal 共用 tab bar，不限數量。Tab 有 `type` 和 `provider` 欄位：

```
Tab { id, name, type: 'terminal' | 'agent', provider?: AgentProvider }
```

- 現有 terminal tab 邏輯不受影響
- Agent tab 渲染 `AgentView` 元件（非 `TerminalView`）
- Tab bar 用 icon 區分兩種 type

### D2. Provider 是 Tab 層級選擇，Project 層級 Default

Provider 跟著 tab 走，同 project 可以同時開不同 provider 的 agent tab。

```
type AgentProvider = 'claude' | 'copilot' | 'gemini'
```

**Project Default Provider：**
- `ProjectConfig` 新增 `defaultAgentProvider` 欄位
- 新增 project 時在流程中選擇（可選 None）
- 可在 ProjectEditPanel 修改

**新增 Tab 流程（`+` 右鍵選單）：**

```
右鍵 [+]
  ├─ Terminal
  ├─ Agent (Claude)     ← 直接開 default provider（有設定時顯示）
  └─ Agent ▸            ← 展開選其他 provider
       ├─ Claude
       ├─ Copilot
       └─ Gemini
```

**新增 Project 流程：**

```
1. 選 Connection Type（Local / SSH / Docker / WSL）
2. 選目錄
3. 選 Default Agent Provider（Claude / Copilot / Gemini / None）
4. 完成
```

### D3. Agent 與 Terminal 互不干涉

Agent 有自己的 tool execution sandbox（SDK 內建），不操作使用者的 terminal tab。未來可透過 event bus 加橋接（如「從 terminal 選取內容送給 agent」），但 v1 不做。

### D4. 獨立模組，不走 Connector

Agent 的通訊模式（async generator、工具權限、session 管理）與 shell connector 完全不同。獨立放在 `src/main/agent/`，走自己的 IPC channel。

### D5. Remote Agent 自動部署（Auto-Deploy）

Remote project（SSH/Docker）開 agent tab 時，自動將 agent server bundle 部署到遠端執行。

**部署路徑按版本隔離：**

```
~/.shelf/agent-server/
├── 0.7.0/
│   └── index.js
├── 0.8.0/
│   └── index.js
```

- 檢查遠端 `~/.shelf/agent-server/<version>/` 是否存在
- 不存在 → 透過 connector upload 傳送 bundle（不覆蓋其他版本）
- 存在 → 直接啟動，不需比對版本號
- 透過 `connector.exec()` 啟動，使用 **stdin/stdout** 通訊（不開 port）
- 部署兩個檔案：agent server（esbuild 單檔 ~5MB）+ Claude Code CLI（`cli.js` ~12MB）

**版本號跟隨 app 版本**（`package.json` version），不獨立維護。偶爾 app 升版但 agent-server 沒改動時會多部署一次，但 ~17MB 的成本可接受，省去獨立版本號的維護負擔。

**版本隔離好處：** 多人用不同版本的 Shelf 連同一台 server 互不干擾，升級不影響他人。

**TODO：** 舊版本清理機制（目前不處理，每個版本 ~17MB）

**Build pipeline：** agent-server bundle 隨主 app build 一起打包（esbuild 單檔），產出放在 Electron resources 內，部署時直接從 app 內讀取上傳。

通訊模式類似 LSP over SSH，複用現有 SSH ControlMaster multiplexing。Docker 也天然支援 stdin/stdout。

**Node.js 環境：** 啟動前透過 project 的 init script 初始化環境（nvm use 等），不主動偵測或掃描：

```sh
eval "<init-script>" >/dev/null 2>&1; exec node ~/.shelf/agent-server/0.7.0/index.js
```

init script 的 stdout 導到 /dev/null 避免污染 JSON protocol。

**前提條件：**
- 遠端需有 Node.js runtime（找不到則在 AgentView 提示使用者設定 init script）
- Docker container 重建後需重新部署（提示使用者 mount volume）

### D6. API Key / Auth 由使用者自行處理

Shelf 不代理、不傳遞任何 API credential。遠端的 auth（`~/.anthropic/`、`ANTHROPIC_API_KEY` 等）由使用者自己在遠端設定，跟現在使用者在遠端 terminal 跑 `claude` 一樣。

- Transport 層不處理 credential，減少安全風險
- Auth 失敗時 server 回報錯誤，Shelf 顯示給使用者即可
- 不同 provider 的 auth 方式不同（Anthropic API key、GitHub token、Google auth），統一交給使用者

### D7. Agent Server 部署為兩個獨立檔案

部署到遠端的檔案不 bundle 成單檔，而是兩個獨立檔案：

```
~/.shelf/agent-server/<version>/
├── index.js    # agent server（esbuild 單檔 ~5MB，不帶 node_modules）
└── cli.js      # Claude Code CLI（~12MB，SDK 自帶的自包含單檔）
```

- `index.js`：agent server 本體，esbuild bundle，不需要在遠端 `npm install`
- `cli.js`：Claude Code CLI runtime，SDK 自帶，可獨立運行（已驗證 `node cli.js --version` 通過）
- agent server 啟動時透過 SDK 的 `pathToClaudeCodeExecutable` option 指定 `cli.js` 路徑
- CLI 會自動讀取遠端的 `~/.claude/`（OAuth token）或 `ANTHROPIC_API_KEY`，auth 機制與 D6 一致
- 分開部署的好處：cli.js 更新時只換一個檔案

**已確認：** SDK dependency tree 全部是純 JS，無 native module。


---

## Architecture

### Module Structure

```
src/main/agent/
├── index.ts              # AgentManager — session 生命週期、IPC handler、根據 connection type 決定 local/remote
├── types.ts              # AgentBackend interface、AgentMessage、SessionState
├── providers/
│   ├── claude.ts              # Claude SDK backend（spawn CLI）
│   ├── copilot.ts             # Copilot backend（連線設定 → openai-processor）
│   ├── gemini.ts              # Gemini backend（連線設定 → openai-processor）
│   └── openai-processor.ts    # 通用 OpenAI-compatible 底層（tool execution loop、streaming、permission、session）
├── remote.ts              # Remote agent-server spawn + stdin/stdout JSON protocol 通訊
├── deploy.ts              # Remote bundle 版本檢查 + 上傳
└── usage-tracker.ts       # Token/cost/rate-limit 追蹤

agent-server/              # 獨立打包，部署到遠端執行
├── index.ts               # stdin/stdout JSON protocol entry
├── providers/             # 與 src/main/agent/providers/ 共用邏輯
└── package.json

src/renderer/
├── components/
│   ├── AgentView.tsx       # Agent 對話 UI（訊息列表 + 輸入框）
│   ├── AgentMessage.tsx    # 單一訊息渲染（text/thinking/tool_use/tool_result）
│   ├── AgentToolCall.tsx   # Tool call 展開/收合 UI
│   ├── AgentPermission.tsx # Permission request dialog
│   └── AgentStatusBar.tsx  # Token/cost/model 狀態列
```

### Backend Interface（多 Provider 抽象）

從 `agent-terminal-copilot` 的設計衍生，統一三個 provider 的介面：

```typescript
interface AgentBackend {
  // Core
  query(prompt: string, opts?: QueryOptions): AsyncGenerator<AgentMessage>
  stop(): void

  // Permission
  setPermissionHandler(handler: PermissionHandler): void
  setPermissionMode(mode: PermissionMode): Promise<void>

  // State
  isInitialized(): boolean
  getRawUsage(): RawUsageData

  // Provider-specific
  getSlashCommands(): CommandInfo[]
  executeCommand(name: string, args?: string): Promise<CommandResult | null>

  // Lifecycle
  onInit(callback: (info: InitInfo) => void): void
  dispose(): void
}
```

### AgentMessage Protocol

統一所有 provider 輸出為同一格式：

```typescript
interface AgentMessage {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'error'
  content: string
  // Tool-specific
  toolName?: string
  toolInput?: Record<string, unknown>
  toolUseId?: string
  parentToolUseId?: string
  // Session
  sessionId?: string
  // Usage
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
}
```

### Session Management

每個 agent tab 維護 **per-provider 的 session**，支援切換 provider 後切回時 resume：

```typescript
interface AgentSession {
  tabId: string
  projectId: string
  activeProvider: AgentProvider
  // 每個 provider 各自的 session 狀態
  providerSessions: Partial<Record<AgentProvider, ProviderSession>>
}

interface ProviderSession {
  backend: AgentBackend
  state: SessionState        // idle | streaming | waiting_permission | error
  sdkSessionId?: string      // Provider 層級的 session ID，用於 resume
  metadata: SessionMetadata  // tokens, cost, turns, duration
  permissionMode: PermissionMode
}
```

**Session 生命週期：**
1. 開 agent tab → `AgentManager.createSession(tabId, projectId, provider)`
2. 使用者送訊息 → `AgentManager.sendMessage(tabId, prompt)`
3. 串流回應 → IPC broadcast `agent:message` / `agent:tool-use` / `agent:stream`
4. Tool permission → IPC `agent:permission-request` ↔ `agent:permission-resolve`
5. 切換 provider → 暫停當前 provider session（保留 sdkSessionId）→ 啟動或 resume 目標 provider session
6. 關 tab → `AgentManager.destroySession(tabId)`（清理所有 provider sessions）
7. App 重啟 → Claude 用 `sdkSessionId` resume，Copilot/Gemini 用 openai-processor 的 message history resume

**Provider 切換流程：**
```
Claude 對話中 → Switch to Gemini
  1. 存下 providerSessions.claude.sdkSessionId
  2. 舊訊息淡化 + 插入分隔線
  3. 建立或 resume providerSessions.gemini

Gemini 對話中 → Switch back to Claude
  1. 存下 providerSessions.gemini.sdkSessionId
  2. 舊訊息淡化 + 插入分隔線
  3. 用 providerSessions.claude.sdkSessionId resume → 接回原本 context
```

### Remote Agent Tab 啟動流程

```
使用者在 Remote Project 開 agent tab
  │
  ├─ 1. 透過 connector.exec() 檢查 Node.js
  │     eval "<init-script>" >/dev/null 2>&1; node --version
  │
  │  ├─ 沒有 node → AgentView 顯示錯誤：
  │  │   "Remote server requires Node.js.
  │  │    Configure your project init script to set up Node environment."
  │  │   [Retry]
  │  │
  │  └─ 有 node → 繼續
  │
  ├─ 2. 檢查遠端 ~/.shelf/agent-server/<version>/ 是否存在
  │
  │  ├─ 不存在 → connector.uploadFile() 部署 bundle
  │  └─ 存在 → 跳過部署
  │
  ├─ 3. 啟動 agent server
  │     eval "<init-script>" >/dev/null 2>&1; exec node ~/.shelf/agent-server/<version>/index.js
  │     stdin/stdout JSON protocol 通訊
  │
  │  ├─ auth 失敗（SDK 回 401/403）→ AgentView 顯示錯誤：
  │  │   "Authentication required on remote server."
  │  │   [Open Terminal Tab]  [Retry]
  │  │
  │  └─ 成功 → 進入正常對話流程
  │
  └─ Local Project 則跳過 1-3，直接在 main process 呼叫 SDK（LocalTransport）
```

### IPC Channels

```typescript
// Main → Renderer (broadcast)
'agent:message'              // AgentMessage
'agent:tool-use'             // Tool call started
'agent:tool-result'          // Tool call completed
'agent:permission-request'   // Needs user approval
'agent:stream'               // Partial content (text/thinking delta)
'agent:status'               // Usage/metadata update
'agent:result'               // Query completed
'agent:error'                // Error
'agent:session-reset'        // Session cleared
'agent:mode-change'          // Permission mode transition

// Renderer → Main (invoke)
'agent:send'                 // { tabId, prompt }
'agent:stop'                 // { tabId }
'agent:resolve-permission'   // { tabId, toolUseId, result }
'agent:set-mode'             // { tabId, mode }
'agent:reset-session'        // { tabId }
'agent:switch-provider'      // { tabId, provider }
'agent:execute-command'      // { tabId, command, args }
```

### Event Bus Integration

Agent 相關的 user action 透過現有 event bus：

```typescript
// events.ts 新增
NEW_AGENT_TAB     // 開新 agent tab
CLOSE_AGENT_TAB   // 關閉 agent tab（觸發 session cleanup）
```

Tab 的 `CLOSE_TAB` 事件在 `App.tsx` handler 中判斷 tab type，agent tab 額外呼叫 `AgentManager.destroySession()`。

---

## Provider Implementation Notes

### Claude Code (`@anthropic-ai/claude-agent-sdk`)

最完整的 provider，參考 `better-agent-terminal` 的實作：

- `query()` 回傳 async generator，串流 text/thinking/tool_use/tool_result
- Session resume via `options.resume: sdkSessionId`
- Permission callback via `canUseTool`
- Subagent tracking（Agent/Task tool 的 parent-child 關係）
- Context compaction detection（zeroed modelUsage）
- `pathToClaudeCodeExecutable`：Local 指向 `process.resourcesPath` 內的 `cli.js`，Remote 指向 `~/.shelf/agent-server/<version>/cli.js`
- Query options: `systemPrompt: 'claude_code'`, `tools: 'claude_code'`, `thinking: 'adaptive'`

**Quota 注意事項：**
- SDK 內部處理 rate limit retry
- `rate_limit_event` 訊息透過 UsageTracker 監控
- 顯示 token 用量和成本讓使用者自行判斷

### Copilot / Gemini（OpenAI-compatible，透過 openai-processor）

兩者都走 OpenAI-compatible API，各自只提供連線設定（endpoint URL、auth header、model name），底層共用 `openai-processor`：

- **openai-processor** 統一處理：
  - Streaming chat completion（SSE）
  - Tool execution loop（收 tool_call → 執行 → 送 result → 繼續）
  - Permission callback（攔截 tool 執行，問使用者）
  - Session management（保存 message history，支援 resume）
  - Usage tracking（response `usage` 欄位）

- **Copilot**：GitHub Copilot API endpoint + GitHub token auth
- **Gemini**：Google Gemini API endpoint + Google auth

新增 OpenAI-compatible provider（如 Ollama、Mistral）只需提供連線設定，不用重新實作 tool loop。

---

## UI Design

### AgentView Layout

```
┌─────────────────────────────────────────┐
│  AgentStatusBar (model | tokens | cost) │
├─────────────────────────────────────────┤
│                                         │
│  Message List (scrollable)              │
│                                         │
│  ┌─ User ─────────────────────────────┐ │
│  │ prompt text                        │ │
│  └────────────────────────────────────┘ │
│                                         │
│  ┌─ Claude: ──────────────────────────┐ │
│  │ [thinking] collapsed by default    │ │
│  │ response text                      │ │
│  │ ┌─ Tool: Edit ───────────────────┐ │ │
│  │ │ file: src/foo.ts               │ │ │
│  │ │ status: completed ✓            │ │ │
│  │ │ [expand to see diff]           │ │ │
│  │ └────────────────────────────────┘ │ │
│  └────────────────────────────────────┘ │
│                                         │
│  ── Switched to Gemini ──               │
│                                         │
│  ┌─ Gemini: ─────────────────────────┐  │
│  │ response text                     │  │
│  └────────────────────────────────────┘  │
│                                         │
│  ┌─ Permission Request ──────────────┐  │
│  │ Tool: Bash                        │  │
│  │ Command: rm -rf dist              │  │
│  │ [Allow] [Deny] [Allow All]        │  │
│  └────────────────────────────────────┘  │
│                                         │
├─────────────────────────────────────────┤
│  Input Area                             │
│  [textarea] [Send] [Stop] [Mode: ▾]    │
│  [slash commands]                       │
└─────────────────────────────────────────┘
```

### 訊息標示

- Assistant 訊息前綴使用 **provider name**（Claude: / Gemini: / Copilot:），不用 model name
- 具體 model name 顯示在 AgentStatusBar
- 切換 provider 後舊訊息保留但視覺淡化，插入分隔線

### Tab 內切換 Provider

Agent tab 支援右鍵 → Switch Provider，用於 quota 滿時切換替代方案：

```
⚠ Switching to Gemini.
  Current Claude session will be paused and can be resumed later.
  Context will not transfer between providers.
  [Cancel]  [Switch]
```

- 確認後舊訊息保留（淡化）、插入 system message 分隔線（`── Switched to Gemini ──`）
- 切回之前用過的 provider 時，自動 resume 該 provider 的 session（接回原本 context）
  - Claude：透過 SDK 的 `sdkSessionId` resume
  - Copilot/Gemini：透過 openai-processor 保存的 message history resume
- 切到未用過的 provider 時，開新 session
- Tab icon 更新為新 provider

### 視覺風格參考

以現有 Shelf Terminal 為主體，agent 相關元件參考 `agent-terminal` 的風格融合：

- **整體**：沿用 Shelf 的 theme 系統（5 個內建主題），agent view 跟隨當前 theme
- **訊息區**：monospace 字體、compact spacing（8px/12px/16px）、訊息間用 `1px border` 分隔
- **角色標示**：provider name 用語意色彩區分（如 Claude 用 accent、Gemini 用不同色）
- **Tool call**：左邊 border 標示狀態色（running=accent、completed=green、error=red）
- **Thinking block**：collapsed by default、chevron 展開、背景略深於訊息區
- **Permission**：黃色左 border + 淡背景，與 tool call 視覺區隔
- **Input area**：跟 Shelf 的 terminal 視覺一致，prompt 符號 + 透明 textarea
- **Switch 分隔線**：舊訊息 opacity 降低、分隔線用 `border + system message`

不另建獨立的 agent 色彩系統，所有顏色從 Shelf theme 的 CSS variables 延伸。

### Tab Bar 變化

- Terminal tab: 現有 icon
- Agent tab: 不同 icon（如 sparkle/bot icon），依 provider 可區分
- Agent tab streaming 時 icon 顯示動畫或 indicator
- Agent tab 完成回應時顯示 unread badge（與 terminal tab 共用同一套機制）

### Split View

Split view 不限 tab type，可以 terminal + agent 並排。現有 CSS flex 佈局不需要改動，AgentView 只需跟 TerminalView 一樣支援 resize。

### Bottom Bar

Agent tab 啟用時暫時隱藏 bottom bar（現有的 connection/cwd/branch 資訊與 agent 不相關）。後續再討論是否整合顯示 provider/model/tokens 等資訊。

### 快捷鍵

Agent 不需要新增 app 層級快捷鍵。現有快捷鍵（`mod+t` 開 tab、`mod+shift+[/]` 切 tab、`mod+1~9` 跳 tab、`mod+\` split）已足夠。

Agent view 內部的鍵盤操作直接在 AgentView 元件內處理（非 app keybinding）：
- **enter** — 送出訊息
- **shift+enter** — 手動換行（textarea 原生行為）
- **escape** — stop agent streaming
- 多行輸入靠 textarea 自動 wrap + auto-grow height，不需要特別按鍵

---

## Implementation Phases

### Phase 1 — Foundation (MVP)

**目標：Claude Code 單一 provider，Local + Remote 基本對話功能**

#### Phase 1a — Tab 基礎（✅ 已完成）

1. `src/shared/types.ts` — TabType、AgentProvider、ProjectConfig.defaultAgentProvider/openAgentOnConnect
2. `src/renderer/store.ts` — Tab model 支援 type/provider、setTabProvider
3. `src/renderer/events.ts` — NEW_AGENT_TAB event
4. `src/renderer/components/TabBar.tsx` — 右鍵選單（Terminal/Agent）、agent tab icon
5. `src/renderer/components/AgentView.tsx` — placeholder + provider picker
6. `src/renderer/App.tsx` — agent tab 渲染分流、event handler、connect 時自動開 agent tab
7. `src/renderer/components/FolderPicker.tsx` — 新增 project 時選 default agent + open on connect
8. `src/renderer/components/ProjectEditPanel.tsx` — 修改 default agent + open on connect

#### Phase 1b — Agent 核心（Local）

安裝 SDK，建立 AgentManager 和 Claude provider，本機可對話。

1. 安裝 `@anthropic-ai/claude-agent-sdk`
2. 型別定義
   - `src/main/agent/types.ts` — AgentBackend interface、AgentMessage、SessionState、ProviderSession
   - `src/shared/ipc-channels.ts` — 新增 agent IPC channels
3. Agent 核心
   - `src/main/agent/index.ts` — AgentManager（session CRUD、IPC handler、message loop）
   - `src/main/agent/providers/claude.ts` — Claude backend（query、stop、基本 permission）
   - `src/main/agent/usage-tracker.ts` — 基本 token/cost 追蹤
4. IPC 接線
   - `src/main/index.ts` — 註冊 agent IPC handlers
   - `src/main/preload.ts` — 暴露 agent API 到 renderer
   - `src/renderer/env.d.ts` — window.shelfApi 型別擴充

#### Phase 1c — 對話 UI

AgentView 從 placeholder 變成真正的對話介面。

1. `src/renderer/components/AgentView.tsx` — 訊息列表 + 輸入框 + Send/Stop 按鈕
2. `src/renderer/components/AgentMessage.tsx` — 單一訊息渲染（user/assistant/system、provider name 前綴）
3. `src/renderer/components/AgentToolCall.tsx` — Tool call 展開/收合
4. 串流顯示（text delta 即時更新）
5. Auto-scroll + auto-grow textarea

#### Phase 1d — Remote 支援

支援 SSH/Docker project 的 agent 功能。不需要 transport 抽象層 — IPC 已是分界點，AgentManager 根據 connection type 決定 local（直接呼叫 SDK）或 remote（spawn agent-server）。

1. IPC `agent:send` 多傳 `connection` 參數
2. AgentManager 判斷 connection type → local 直接呼叫 SDK / remote 走 agent-server
3. `src/main/agent/deploy.ts` — Remote bundle 版本檢查 + 上傳
4. `src/main/agent/remote.ts` — connector.exec() spawn agent-server + stdin/stdout JSON 通訊
5. `agent-server/index.ts` — stdin/stdout JSON protocol entry
6. `agent-server/` build script（esbuild 單檔 bundle）

#### Phase 1e — 驗證

1. 單元測試：AgentManager session lifecycle、message protocol mapping
2. E2E 測試：開 agent tab、送訊息、收到回應（需要 mock SDK）

### Phase 2 — Permission & Session & UX

**目標：完整的權限控制、session 管理、agent 對話 UX**

#### Phase 2a — Permission（功能正確性）

1. Permission request UI（AgentPermission.tsx）— tool call 時顯示 Allow/Deny
2. Permission mode 切換（default / acceptEdits / bypassPermissions）— 在 input area 的 Mode 下拉選單
3. Claude backend 接入 SDK `canUseTool` callback

#### Phase 2b — Session

1. Session resume（切 tab 回來、app 重啟後接續對話）
2. Session reset（清空對話、重新開始）

#### Phase 2c — UX 改善

1. AgentStatusBar 完善（tokens、context window %、5h/7d rate limit 用量 + 重置倒數）
2. Slash command autocomplete（`/` 觸發選單，顯示 SDK `getSlashCommands()` 結果）

#### Phase 2d — 進階（延後）

1. Subagent task tracking + stall detection
2. Tool call diff 預覽

#### Phase 2 已完成

- Thinking block 收合展開 ✅（Phase 1c）
- Tool call 展開/收合 ✅（Phase 1c）

### Phase 3 — Multi-Provider

**目標：擴展支援 Copilot 和 Gemini**

1. `src/main/agent/providers/openai-processor.ts` — 通用 OpenAI-compatible 底層（tool execution loop、streaming、permission、session）
2. `src/main/agent/providers/copilot.ts` — 連線設定（endpoint、auth、model）
3. `src/main/agent/providers/gemini.ts` — 連線設定（endpoint、auth、model）
4. Provider-specific 設定 UI（API key、model 選擇）
5. Tab 內 Switch Provider 功能

### Phase 4 — Polish & Enhancement

**目標：進階功能強化**

1. Session history 持久化 ✅ — IndexedDB 存 messages、ProjectConfig 存 sdkSessionId、30 天 auto-rotate

### 已評估不做的功能

| Feature | 原因 |
|---------|------|
| Image attachment（貼路徑顯示圖片） | 需要依 connection type 讀遠端檔案，跟「agent 獨立」原則衝突，暫緩 |
| Clickable file paths + preview | 偏 IDE 角色，使用者有 terminal 可以直接查看 |
| File browser / Git panel | 偏 IDE 角色 |
| Snippet manager | 與現有 quick commands 定位重疊 |
| i18n | 維護成本高，使用者群不大 |
| Detachable windows / Remote access / Profile | 架構複雜度太高，與 Shelf 輕量定位衝突 |
| Per-project 環境變數 | Init script 已能做同樣的事（`export KEY=VAL`），UI 差異不值得額外維護 |
| Terminal ↔ Agent 橋接 | 和複製貼上無差別，不值得額外實作 |
| Context compaction 偵測 | Claude SDK 特有功能，非通用 |

---

## Risk & Mitigation

| Risk | Mitigation |
|------|------------|
| SDK quota 再次異常 | UsageTracker 顯示即時用量，讓使用者可見可控 |
| SDK 版本更新 breaking change | Pin SDK 版本，升級前跑完整測試 |
| Local project 找不到 cli.js | cli.js 放在 Electron resources（`process.resourcesPath`），不從 node_modules 讀，不受 asar 影響 |
| Agent tab 記憶體佔用 | 先不限制訊息數量（provider switch 需保留舊訊息）。Thinking block collapsed by default 減少 DOM 量。遇到實際效能問題再加 virtualized list |
| 多 provider 介面差異大 | openai-processor 統一 OpenAI-compatible provider 的能力，與 Claude SDK 對齊，interface 差異最小化 |
| SDK 含 native module 導致無法 esbuild 單檔 | ✅ 已確認無 native module。CLI 為獨立自包含檔案，與 agent server 分開部署 |

---

## Dependencies

```
@anthropic-ai/claude-agent-sdk  — Claude Code provider（Phase 1）
openai                          — Copilot / Gemini openai-processor（Phase 3）
```
