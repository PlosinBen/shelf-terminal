# Agent SDK Integration — Architecture Plan

## Overview

在 Shelf Terminal 中整合 AI agent 對話功能，支援多 provider（Claude Code、Copilot、Gemini），以專屬 agent tab 呈現結構化對話 UI。

> **v0.8 狀態**：Claude / Copilot 已上線，Gemini backend 保留但在 picker 中隱藏（`AGENT_PROVIDERS` 的 `hidden: true`）。原因：
> 1. 目前只做 API key 路線（AI Studio），不吃 Gemini Advanced / Google One 訂閱 quota，使用者需要另開 billing。
> 2. Gemini CLI 實測回應速度偏慢，UX 不理想。
>
> 重開條件：評估加 OAuth（`@google/gemini-cli-core`）路線吃訂閱 quota。OAuth 會是獨立的 sdk-managed adapter，不走 engine（Gemini 原生協議非 OpenAI compat）。詳見「與 Copilot 的 auth 比較」段。

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

### D6. Auth — Delegated，不做 OAuth flow

Shelf 不做自己的 device flow / OAuth UI，credentials 一律走使用者既有的官方工具：

- **Claude**：`~/.anthropic/` / SDK 自己處理
- **Copilot**：先讀 `~/.config/github-copilot/apps.json`（vim/neovim / copilot CLI 寫的）→ 再試 `gh auth token`（需要 `copilot` scope）→ 都沒有 → UI 顯示指示讓使用者自己跑 `gh auth login -s copilot` / `gh auth refresh -s copilot` / `copilot`
- **Gemini**：待設計，預計同模式（Google OAuth 官方工具 or gcloud auth）

設計原因：
- 自己做 device flow 要借 copilot.vim 的 client_id，有被 GitHub revoke 的風險，且 100+ 行要維護
- 使用者是開發者，開 terminal 跑 auth 指令不是障礙
- 官方工具維護 token refresh / scope 更新，我們免費搭便車
- Transport 層不傳遞 credential，減少安全風險

Session token（如 Copilot 30 分鐘過期的那個）processor 每次 request 前自動 refresh，使用者無感。

Auth 失敗時 backend 發 `auth_required` event，AgentView 換成 sign-in 指示畫面 + Retry 按鈕。

### D7. Claude Code Runtime：平台相依 native binary

SDK 0.2.x 起 **沒有 `cli.js`**。真正的 Claude Code runtime 是每平台一顆 self-contained native binary（bun 編出來，~40MB），透過 optionalDependencies 裝：

```
node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude[.exe]
```

`@anthropic-ai/claude-agent-sdk` 本體只有 `sdk.mjs`、`bridge.mjs` 等 wrapper，`query()` 時用 `child_process.spawn` 跑上面那顆 binary，走 stdin/stdout stream-json 協定。

**Local（packaged app）**

- `package.json` 的 `build.files` 加 `node_modules/@anthropic-ai/claude-agent-sdk-*/**/*` 把 platform 包帶進 app
- `build.asarUnpack` 把 `claude` / `claude.exe` 從 asar 解出來（`spawn` 走真實 FS，路徑含 `app.asar` 會 ENOTDIR）
- `src/main/agent/providers/claude.ts` 的 `resolveClaudeBinaryPath()` 依 `process.platform + process.arch` 算出 `app.asar.unpacked/node_modules/.../claude` 路徑，傳給 SDK `pathToClaudeCodeExecutable`
- CI 每平台各自 build，只會帶自己那顆 binary（dmg/nsis/AppImage 不會同梱別人的）

**Remote（agent-server，TODO v0.9）**

遠端目前是壞的——`agent-server/providers/claude.ts:44,85` 指向 `__dirname/cli.js`，但 SDK 0.2.x 已經沒有 cli.js；`deploy.ts:66` 的 `existsSync(cliSrcPath)` 本機也找不到東西可上傳。

計畫走 **按需下載**：shelf 主程序依遠端 platform/arch 從 npm registry HTTPS 抓對應 `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` 的 tarball，本機解壓（node 內建 `zlib` + tar parser）取出 `claude` binary，透過 `connector.uploadFile()` 丟到 `~/.shelf/agent-server/<version>/claude` 並 `chmod +x`。遠端不需 node/npm，只要 SSH 連得上即可。deploy 後 `agent-server/providers/claude.ts` 的 `pathToClaudeCodeExecutable` 改指 `path.join(__dirname, 'claude')`。

替代方案（已評估、不採用）：
- 全平台 bundle 進 dmg：+300MB，每次 SDK 升版要抓全平台
- 遠端自裝 `npm i -g @anthropic-ai/claude-agent-sdk`：要求遠端有 node+npm+npm registry 連線，版本難對齊


---

## Architecture

### Module Structure

```
src/main/agent/
├── index.ts              # AgentManager — session 生命週期、IPC handler、根據 connection type 決定 local/remote
├── types.ts              # AgentBackend (method-per-capability) interface、AgentMessage、SessionState
├── engine/
│   ├── index.ts               # createEngine factory — 通用 OpenAI-compatible agent loop（tool execution、streaming、permission、slash commands、/compact）
│   ├── types.ts               # OpenAIAdapter / ModelCatalog / CredentialSource
│   └── credential.ts          # createStaticCredentialStore — env var → ~/.config/shelf/{id}.json
├── tools/
│   ├── registry.ts            # TOOLS + SLASH_COMMANDS + toolsForMode + getEffortLevels + buildSystemPrompt
│   └── executor.ts            # ExecFn-based dispatch + loadProjectInstructions (AGENTS.md / CLAUDE.md)
├── providers/
│   ├── claude.ts              # Claude SDK backend（spawn CLI）— ensureInit cache
│   ├── copilot.ts             # Copilot adapter + createEngine
│   └── gemini.ts              # Gemini adapter + createEngine + credential store（v0.8 picker 隱藏）
├── auth/
│   └── copilot-auth.ts        # GitHub token 解析 + Copilot session exchange
├── remote.ts              # Remote agent-server spawn + stdin/stdout JSON protocol（oneShotRequest 轉發 capabilities / credential / auth）
├── deploy.ts              # Remote bundle 版本檢查 + 上傳
└── usage-tracker.ts       # Token/cost/rate-limit 追蹤

agent-server/              # 獨立打包，部署到遠端執行
├── index.ts               # stdin/stdout JSON protocol entry + provider dispatch
├── providers/
│   ├── claude.ts              # + canUseTool 轉發
│   ├── copilot.ts
│   ├── copilot-auth.ts        # remote 端 GitHub token 解析
│   └── gemini.ts
├── tool-exec.ts           # localExec (child_process) 取代 connector.exec
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
7. App 重啟 → Claude 用 `sdkSessionId` resume，Copilot/Gemini 用 engine 內部保存的 message history resume

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
- `pathToClaudeCodeExecutable`：Local 用 `resolveClaudeBinaryPath()` 解 `app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude` (見 D7)。Remote 暫時壞掉，v0.9 接按需下載後指 `~/.shelf/agent-server/<version>/claude`
- Query options: `systemPrompt: 'claude_code'`, `tools: 'claude_code'`, `thinking: 'adaptive'`

**Quota 注意事項：**
- SDK 內部處理 rate limit retry
- `rate_limit_event` 訊息透過 UsageTracker 監控
- 顯示 token 用量和成本讓使用者自行判斷

### Copilot / Gemini（OpenAI-compatible，透過 engine + adapter）

兩者都走 OpenAI-compatible API，各自只提供連線設定，底層共用 `engine` 實作 agent loop。新增 OpenAI-compatible provider（Ollama、Mistral）只需寫 thin wrapper。

#### Processor vs Provider 責任切分

| 功能 | Processor 層 | Provider wrapper 層 |
|---|---|---|
| Chat completion streaming | ✅ SSE + text delta | — |
| Tool call 串流累積 | ✅ 跨 chunk accumulate | — |
| Tool execution loop | ✅ multi-turn | — |
| Tool schema registry | ✅ Read/Grep/Glob/Ls/Bash/Edit/Write + category | — |
| Permission gating | ✅ default/acceptEdits/bypass/plan 邏輯 | — |
| Plan mode tool filter | ✅ 只露 `category: 'read'` + system prompt | — |
| `reasoning_effort` 參數 | ✅ 塞進 request | ✅ 透過 `getEffortLevels(modelId)` pattern 檢測 |
| Model 參數 | ✅ 塞進 request | ✅ 宣告 model 清單、context window 表 |
| Token usage | ✅ `stream_options.include_usage` | — |
| Context % | ✅ 用 usage / window 算 | ✅ 提供 window 對應表 |
| Rate limit / quota | — | ✅ 解析 provider-specific header（Copilot `X-Copilot-Quota-*`） |
| Endpoint / headers / auth token | — | ✅ |
| Permission modes 清單 | ✅ 固定 `['default','acceptEdits','bypassPermissions','plan']` | — |

**為什麼 permission 全在 processor**：tool 是 Shelf 自己執行，不關 API 的事，所以 gating 邏輯對所有 OpenAI-compat provider 一致。

#### Tool Registry & Categories

```typescript
const TOOLS = {
  Read:  { category: 'read',  schema: {...} },
  Grep:  { category: 'read',  schema: {...} },
  Glob:  { category: 'read',  schema: {...} },
  Ls:    { category: 'read',  schema: {...} },
  Bash:  { category: 'exec',  schema: {...} },  // 不細分讀寫，由 mode 控
  Edit:  { category: 'write', schema: {...} },
  Write: { category: 'write', schema: {...} },
};
```

#### Permission Mode 語意

| Mode | Read | Exec (Bash) | Write (Edit/Write) |
|---|---|---|---|
| `default` | 問使用者 | 問使用者 | 問使用者 |
| `acceptEdits` | 自動過 | 問使用者 | 自動過 |
| `bypassPermissions` | 自動過 | 自動過 | 自動過 |
| `plan` | 自動過 | ❌ 不給 model | ❌ 不給 model |

`plan` 模式兩道保險：
1. Tool filter — 只在 request 送 `category: 'read'` 的 tool schema，model 看不到 Edit/Write/Bash，想用也沒 API 可呼叫
2. System prompt 注入："You are in plan mode. Explore the code and produce a plan. Do not execute commands or modify files."

#### Reasoning Effort 偵測

OpenAI 沒提供官方 API 查「哪個 model 吃 `reasoning_effort`」。`tools/registry.ts` 的 `getEffortLevels(modelId)` 用 pattern match 推論：

- `^gpt-5(?!-chat)` → `['minimal', 'low', 'medium', 'high']`
- `^o\d` → `['low', 'medium', 'high']`
- 其他 → `[]`（UI 隱藏 effort chip，request 不帶參數）

做法與 Vercel AI SDK (`@ai-sdk/openai`) 一致，是業界慣例。

**⚠️ 需定期驗證**：OpenAI 新 model 家族出來時（如 `o5`、`gpt-6`）要檢查 pattern 是否仍涵蓋。檢查方式：
1. 比對 OpenAI 官方 docs 的 reasoning models 清單
2. 對照 Vercel 最新版 `@ai-sdk/openai` 的 `openai-language-model-capabilities.ts`
3. 實測：對新 model 送帶 `reasoning_effort` 的 request，看是否被接受

若 pattern 沒涵蓋新家族，UI 會少一個 effort chip（非破壞性），但可能錯失該 model 的 reasoning 控制力。建議每次 OpenAI 公告新 model 家族後更新。

#### Warmup 回傳的 slashCommands 來源

`AgentBackend.getSlashCommands()` 由各 provider 回傳；**實際執行邏輯在 engine 內部的 `handleSlash`**（使用 `SLASH_COMMANDS` 清單，定義於 `tools/registry.ts`）。Claude 則直接委派給 SDK 的 `supportedCommands()`。

Copilot wrapper 的寫法：
```ts
return {
  ...,
  slashCommands: processor.getSlashCommands(),
};
```

這造成 wrapper 「反向詢問」processor 的小耦合。替代方案是讓 `ensureSession` 組 capabilities 時由 main 直接補 processor 的 slash，但這會讓 `main/agent/index.ts` 知道「某些 backend 內部有 processor」的細節，違反封裝。

**現行設計：保留 wrapper 委派給 processor 的寫法**，把耦合控制在同一個 `providers/` 目錄內，main 只關心 `AgentBackend` interface。

新增 OpenAI-compatible provider 時，slashCommands 一樣從 processor 取，不用自訂。

#### Provider wrapper 範例

- **Copilot**：
  - Endpoint：`https://api.githubcopilot.com`
  - Auth：GitHub token → `/copilot_internal/v2/token` 換 session token
  - Headers：`Editor-Version: GithubCLI/...`、`Editor-Plugin-Version: github-copilot-cli/...`、`Copilot-Integration-Id: vscode-chat`
  - Models：`/models` endpoint 動態抓
  - Context window 表：gpt-4o: 128k、claude-sonnet-4: 200k、o1: 200k、...
  - Quota：response header `X-Copilot-Quota-*`

- **Gemini**：待設計

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
  - Copilot/Gemini：透過 engine 內部保存的 message history resume
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

**目標：擴展支援 Copilot 和 Gemini，逐步補齊 agent capabilities**

✅ Code-complete for Copilot (local only). Gemini wrapper deferred.

**🚧 Shipped hidden in v0.7.0** — Copilot / Gemini picker entries are temporarily removed from the UI while remote support lands. Backends, tests, and infrastructure stay in the tree for v0.8.

**✅ v0.7.1 (post-v0.7.0) — remote Copilot + Gemini landed**:

- `tool-executor` now takes an `ExecFn` (not a `Connection`) so the same logic works local (wrapping `connector.exec`) and in `agent-server` (wrapping `child_process.exec`).
- `agent-server` refactored into per-provider modules (`providers/claude.ts`, `providers/copilot.ts`, `providers/gemini.ts`) dispatched by `incoming.provider`.
- Protocol extensions: `stream`, `auth_required`, `permission_request` / `resolve_permission`. Permissions flow server → main `canUseTool` → back.
- `remote.ts` now forwards provider, model, effort, images, and hooks `onPermissionRequest` into the user's `canUseTool`.
- `agent-server/build.mjs` uses an `@shared` alias so the engine's logger import resolves when bundled; bundle grows ~200KB → ~720KB with OpenAI SDK.
- Both Copilot and Gemini visible in the provider picker again.

**Pending for later**:

- Retry button on Gemini auth screen is hard-wired to `copilotAuth.recheck` — a generic `agent.recheck` IPC calling `backend.checkAuth()` would cover both.
- Capabilities (model list, context windows) are fetched local-side only; on remote projects Copilot's `/models` call runs from the remote machine's token too — verify this still populates the UI model picker end-to-end.
- Gemini auth is `GEMINI_API_KEY` env var only; a proper settings field / prompt for the key would be friendlier than asking users to export in their shell init.
- Claude remote path doesn't currently forward `canUseTool` — only Copilot / Gemini carry permission prompts across stdin. Claude's SDK runs with whatever default the server sets.

**🚧 v0.8 — Adapter architecture refactor (planned)**

Agreed after discussion: the `providers/engine.ts` monolith is about to become the engine for Copilot / Gemini / future OpenAI / Mistral / Ollama, while each provider should only declare its differences. Instead of patching in more configuration flags we promote the architecture to a proper engine + adapter split with a method-per-capability interface.

### Target layout

```
src/main/agent/
├── engine/                   # OpenAI-compat agent engine (shared across OpenAI-family providers)
│   ├── index.ts              # createEngine(adapter, executor) → AgentBackend
│   ├── types.ts              # OpenAIAdapter, AuthMethod, ModelInfo, CredentialSource
│   ├── client.ts             # OpenAI API call + stream parse + tool_call delta accumulator
│   ├── loop.ts               # Multi-turn agent loop
│   ├── history.ts            # Message history + /compact
│   ├── prompt.ts             # System prompt + AGENTS.md injection + mode directives
│   ├── permissions.ts        # Mode-based gating + canUseTool bridge
│   ├── slash.ts              # /clear /compact /context /help /model /status /tools /ask dispatch
│   └── credential.ts         # Static API key file store (~/.config/shelf/{id}.json)
│
├── tools/                    # Shell tools (engine dependency)
│   ├── registry.ts           # TOOLS schemas + categories + toolsForMode + toOpenAIFormat
│   └── executor.ts           # ExecFn-based dispatch + loadProjectInstructions
│
├── auth/
│   └── copilot-github.ts     # GitHub OAuth token → Copilot session token (special)
│
└── providers/                # One file per actual provider
    ├── claude.ts             # Claude SDK wrapper (bypasses engine, uses method-per-cap with cache helper)
    ├── copilot.ts            # ~30 lines: adapter config + createEngine(...)
    └── gemini.ts             # ~30 lines: adapter config + createEngine(...)
```

### New AgentBackend interface (method-per-capability)

```typescript
interface AgentBackend {
  // Lifecycle
  checkAuth(): Promise<boolean>;
  stop(): Promise<void>;
  dispose(): void;

  // Polymorphic capability getters (composed by main's gatherCapabilities)
  getModels(): Promise<ModelInfo[]>;
  getPermissionModes(): string[];
  getEffortLevels(): string[];
  getSlashCommands(): Promise<SlashCommand[]>;
  getAuthMethod(): AuthMethod;

  // Runtime
  query(prompt, cwd, opts): AsyncGenerator<AgentEvent>;
  setModel(model: string): void;
  setEffort(effort: string): void;

  // Optional — only when authMethod.kind === 'api-key'
  storeCredential?(key: string): Promise<void>;
}

type AuthMethod =
  | { kind: 'api-key'; envVar: string; setupUrl?: string; placeholder?: string }
  | { kind: 'oauth'; instructions: Array<{ label: string; command?: string }> }
  | { kind: 'sdk-managed'; instructions: Array<{ label: string; command?: string }> }
  | { kind: 'none' };
```

Rationale: the older `warmup()` blob hides capability differences inside each provider's warmup implementation. Promoting each capability to a polymorphic method gives the composer (`gatherCapabilities` in main) a uniform `backend.getX()` shape while the provider still encapsulates the diff (Claude from SDK, Copilot/Gemini via engine reading the adapter). Claude absorbs an internal `ensureInit()` cache so multiple getters don't each re-init the SDK.

### Refactor phases (R1–R10) ✅ shipped

- **R1** ✅ — engine/types.ts with OpenAIAdapter / AuthMethod / ModelCatalog, method-per-cap AgentBackend
- **R2** ✅ — tool registry moved to `tools/`; engine relocated to `engine/index.ts`
- **R3** ✅ — Copilot provider is adapter + `createEngine({...})` (~110 lines, down from ~150)
- **R4** ✅ — Gemini provider simplified to adapter + `createEngine({...})` (~40 lines)
- **R5** ✅ — Claude provider exposes the getters with an internal `ensureInit` cache so multiple getters share one SDK plan-mode fetch
- **R6** ✅ — `gatherCapabilities` composes capabilities from getters; `warmup` removed from AgentBackend; `checkAuth` now required
- **R7** ✅ — new `get_capabilities` / `capabilities` protocol; remote backend rides it to populate the UI in one round-trip
- **R8** ✅ — agent-server providers implement `gatherCapabilities` (Claude ensureInit cache; Copilot / Gemini delegate to engine getters)
- **R9** ✅ — AgentView auth-required pane renders off `capabilities.authMethod` discriminated union; no more `isGemini` / provider identity branches
- **R10** ✅ — legacy `openai-processor.ts` / `processor-tools.ts` fully removed (moved into `engine/` and `tools/`)

### Still pending after v0.8 refactor

- Engine internals still live in a single `engine/index.ts` (~420 lines). Split into `loop.ts / prompt.ts / permissions.ts / slash.ts / history.ts / credential.ts` is a nice-to-have but not critical now.
- Credential store (`~/.config/shelf/{provider}.json`) — `authMethod: api-key` is declared but the write-through via `backend.storeCredential` / UI input form isn't implemented yet. Falls back to env var reading.
- Generic `agent.recheck` IPC — current `copilotAuth.recheck` only works for Copilot; Gemini / future API-key providers need a provider-agnostic re-probe.

### Related v0.8 goals

- Credential store (`~/.config/shelf/{provider}.json`, mode 0600) landing through the engine, with UI input for API keys writing via `backend.storeCredential()` to the target machine (never the local userData).
- Retry button becomes a generic `backend.checkAuth()` re-probe — no more copilot-specific `recheck` IPC.
- Claude remote permission forwarding — Claude agent-server wires `canUseTool` through stdin same as Copilot/Gemini do today.
- Version bump on agent-server deploy so remote caches don't serve stale pre-refactor binary.

#### Phase 3a — Tool Registry + Agent Loop 骨架 ✅

- `src/main/agent/tools/registry.ts` — tool schemas + category（Read/Grep/Glob/Ls/Bash/Edit/Write）
- `engine` 多輪 loop：tool_call delta 累積 → execute → tool_result → 繼續
- MAX_TURNS = 20 防跑不停

#### Phase 3b — Tool 實作 ✅

走現有 connector（local / SSH / Docker / WSL）：Read / Grep (rg fallback grep) / Glob (find) / Ls / Bash / Edit / Write；100KB 輸出截斷。

#### Phase 3c — Permission Gating ✅

- `AGENT_PERMISSION_REQUEST` event 重用
- Mode 邏輯：default 問、acceptEdits 自動過 read/write 問 exec、bypass 全過、plan 自動拒 exec/write
- Session allowlist（「allow this session」真的 whitelist tool；Bash 以 command 第一個字為 key）

#### Phase 3d — Plan Mode ✅

- Tool schema filter（plan → 只露 read category）
- System prompt 注入 PLAN MODE 指示
- 兩道保險：model 看不到 exec/write tool 且 system prompt 明示

#### Phase 3e — Status Bar ✅

- `/models` 在 `getModels()` 呼叫時抓一次 → `capabilities.models` + per-model `effortLevels` / `vision`
- `AGENT_SET_PREFS` IPC 切 model/effort/mode；persisted in `ProjectConfig.agentPrefs`
- `stream_options.include_usage` → token counts
- Context % from model context window
- Copilot quota via custom `fetch` response header intercept
- Reasoning content stream (`delta.reasoning_content` / `delta.reasoning`)

#### Phase 3f — Gemini 🚧 (deferred)

套同一套 processor，只寫 thin wrapper。Google auth flow 未設計。

### Phase 3 add-ons shipped ✅

- Slash commands: `/clear /compact /context /help /model /status /tools /ask` via processor `handleSlash`; `/model` opens keyboard picker overlay
- AGENTS.md / CLAUDE.md auto-load at git repo root, injected into system prompt each turn
- Attachments: file upload via connector (text inlined on send, >100KB or binary falls back to path ref) and image data URLs (Copilot `image_url` content block; Claude `image` block via async-generator prompt)
- Vision capability gating
- AgentView keyboard-first input (no send button, double-Esc to stop)
- Immutable store updates (useSyncExternalStore re-render fix)

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
| Local packaged app spawn native binary 撞 ENOTDIR | `asarUnpack` 把 `claude`/`claude.exe` 從 asar 解出；runtime 算出 `app.asar.unpacked` 路徑傳 `pathToClaudeCodeExecutable` (見 D7) |
| Agent tab 記憶體佔用 | 先不限制訊息數量（provider switch 需保留舊訊息）。Thinking block collapsed by default 減少 DOM 量。遇到實際效能問題再加 virtualized list |
| 多 provider 介面差異大 | engine 統一 OpenAI-compatible provider 的能力，與 Claude SDK 對齊，interface 差異最小化 |
| SDK 升級改用 native binary | 0.2.x 已如此；local 走 asarUnpack，remote 待 v0.9 按需下載 (見 D7) |

---

## Dependencies

```
@anthropic-ai/claude-agent-sdk  — Claude Code provider（Phase 1）
openai                          — Copilot / Gemini engine（Phase 3）
```
