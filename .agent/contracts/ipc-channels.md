---
type: contract
title: IPC Channels
related:
  - contracts/agent-wire-protocol
  - contracts/persistence-formats
---

# IPC Channels

The renderer↔main bridge surface — `window.shelfApi.*` methods (RPC over `ipcRenderer.invoke`/`.send`) plus the main→renderer push channels they subscribe to. Channel name constants live in `src/shared/ipc-channels.ts` (`IPC`); the exposed surface is `src/main/preload.ts`; payload types referenced below live in `src/shared/types.ts`. `on*` methods register a listener and return an unsubscribe function.

## pty (`shelfApi.pty`)

| Method | Shape |
|--------|-------|
| `spawn(projectId, tabId, cwd, connection, initScript?, tabCmd?)` | invoke `pty:spawn` → spawn result. `connection` see `Connection` in `src/shared/types.ts` |
| `input(tabId, data)` | send `pty:input` (fire-and-forget) |
| `resize(tabId, cols, rows)` | send `pty:resize` |
| `kill(tabId)` | invoke `pty:kill` |
| `mute(tabId, muted: boolean)` | send `pty:mute` |
| `onData(cb(tabId, data))` | recv `pty:data` → unsubscribe fn |
| `onExit(cb(tabId, exitCode: number))` | recv `pty:exit` → unsubscribe fn |
| `onInitSent(cb(tabId))` | recv `pty:init-sent` → unsubscribe fn |

## project (`shelfApi.project`)

| Method | Shape |
|--------|-------|
| `load()` | invoke `project:load` → `ProjectConfig[]` (see `src/shared/types.ts`) |
| `save(projects)` | invoke `project:save` |
| `validateDirs(projects)` | invoke `project:validate-dirs` → per-project dir-existence result |

## connector (`shelfApi.connector`)

`connection` everywhere is a `Connection` (see `src/shared/types.ts`).

| Method | Shape |
|--------|-------|
| `listDir(connection, path)` | invoke `connector:list-dir` → directory entries |
| `homePath(connection)` | invoke `connector:home-path` → `string` |
| `isConnected(connection)` | invoke `connector:check` → `boolean` |
| `connect(connection, password?)` | invoke `connector:establish` |
| `availableTypes()` | invoke `connector:available-types` → connector type list |
| `uploadFile(connection, cwd, filename, buffer: ArrayBuffer)` | invoke `file:upload` |
| `clearUploads(connection, cwd)` | invoke `file:clear-uploads` |
| `getUploadsSize(connection, cwd)` | invoke `file:uploads-size` → `{ totalBytes, fileCount }` |

Type-specific connector helpers are surfaced as their own namespaces:

| Method | Shape |
|--------|-------|
| `shelfApi.ssh.removeHostKey(host, port)` | invoke `ssh:remove-host-key` |
| `shelfApi.ssh.servers()` | invoke `ssh:servers` → known SSH server list |
| `shelfApi.wsl.listDistros()` | invoke `wsl:list-distros` |
| `shelfApi.docker.listContainers()` | invoke `docker:list-containers` |

## git (`shelfApi.git`)

| Method | Shape |
|--------|-------|
| `branchList(connection, cwd)` | invoke `git:branch-list` → branch list |
| `checkDirty(connection, cwd)` | invoke `git:check-dirty` → `boolean` |
| `checkout(connection, cwd, branch)` | invoke `git:checkout` → `void` |
| `worktreeAdd(connection, cwd, branch, newBranch: boolean)` | invoke `git:worktree-add` |
| `worktreeRemove(connection, cwd, worktreePath)` | invoke `git:worktree-remove` |

## file-transfer

Surfaced through `shelfApi.connector` (`uploadFile` / `clearUploads` / `getUploadsSize`) over channels `file:upload`, `file:clear-uploads`, `file:uploads-size` — see the connector table above.

## dialog (`shelfApi.dialog`)

| Method | Shape |
|--------|-------|
| `warn(title, message)` | invoke `dialog:warn` |
| `confirm(title, message, confirmLabel?)` | invoke `dialog:confirm` → `boolean` |

## settings (`shelfApi.settings`)

| Method | Shape |
|--------|-------|
| `load()` | invoke `settings:load` → `AppSettings` (see `src/shared/types.ts`) |
| `save(settings)` | invoke `settings:save` |

## logs / app (`shelfApi.logs`, `shelfApi.app`)

| Method | Shape |
|--------|-------|
| `logs.clear()` | invoke `logs:clear` |
| `logs.size()` | invoke `logs:size` → `{ totalBytes, fileCount }` |
| `app.logsPath()` | invoke `app:logs-path` → `string` |
| `app.debugLog(tag, msg)` | send `app:debug-log` (fire-and-forget diagnostic log → main log file) |

## notes (`shelfApi.notes`)

Per-project markdown notes; `images` are filenames resolved via `shelf-image://` protocol.

| Method | Shape |
|--------|-------|
| `list(projectId)` | invoke `notes:list` → note metadata list |
| `get(projectId, noteId)` | invoke `notes:get` → note |
| `create(projectId)` | invoke `notes:create` → new note |
| `quickCreate(projectId, body, images = [])` | invoke `notes:quick-create` |
| `update(projectId, noteId, patch: { title?, isDone?, body?, images? })` | invoke `notes:update` |
| `delete(projectId, noteId)` | invoke `notes:delete` |
| `deleteAllDone(projectId)` | invoke `notes:delete-all-done` → `number` (deleted count) |
| `saveImage(projectId, buffer: ArrayBuffer, ext)` | invoke `notes:save-image` → `string` (filename) |
| `readImage(projectId, filename)` | invoke `notes:read-image` → `ArrayBuffer | null` |

## skills (`shelfApi.skills`)

App-level Agent Skills (one folder per skill under userData).

| Method | Shape |
|--------|-------|
| `list()` | invoke `skills:list` → skill list |
| `get(name)` | invoke `skills:get` → skill content |
| `create()` | invoke `skills:create` → new skill |
| `update(name, content)` | invoke `skills:update` |
| `delete(name)` | invoke `skills:delete` |
| `setLocked(name, locked: boolean)` | invoke `skills:set-locked` |
| `onChanged(cb())` | recv `skills:changed` → unsubscribe fn (manager UI or agent bridge mutated skills) |

## mcp (`shelfApi.mcp`)

App-level MCP servers (`<userData>/mcp-servers.json`, keyed object). See `context/mcp`. `McpServerBlock` types in `src/shared/mcp.ts`.

| Method | Shape |
|--------|-------|
| `list()` | invoke `mcp:list` → `Record<name, McpServerBlock>` |
| `get(name)` | invoke `mcp:get` → `McpServerBlock \| null` |
| `add(name, block)` | invoke `mcp:add` → `{ ok, name?, error? }` |
| `update(name, block, nextName?)` | invoke `mcp:update` → `{ ok, name?, error? }` (`nextName` renames) |
| `remove(name)` | invoke `mcp:remove` |
| `onChanged(cb())` | recv `mcp:changed` → unsubscribe fn (config mutated) |

## web (`shelfApi.web`)

Manage the shared web session + the app-global `web.fetch` permission popup. See `context/web-tab`. The `<webview>` itself uses the `persist:web` partition directly (it is not an IPC channel); these methods are the management + permission surface only.

| Method | Shape |
|--------|-------|
| `listSessions()` | invoke `web:list-sessions` → `WebSessionEntry[]` (`{ domain, cookieCount }`, grouped by registrable domain; see `src/shared/web-session.ts`) |
| `deleteSession(domain)` | invoke `web:delete-session` (log out of a registrable domain) |
| `listGrants()` | invoke `web:list-grants` → `WebGrantsByProject` (`{ [projectId]: origin[] }`) |
| `revokeGrant(projectId, origin)` | invoke `web:revoke-grant` |
| `onPermissionRequest(cb(req))` | recv `web:permission-request` → unsubscribe fn. `req`: `WebPermissionMeta & { requestId }` (`{ requestId, origin, registrableDomain, method }`) |
| `resolvePermission(requestId, decision: 'once'|'always'|'deny')` | invoke `web:permission-resolve` |
| `onPermissionClose(cb(requestId))` | recv `web:permission-close` → unsubscribe fn (resolved elsewhere — Telegram / timeout — dismiss the local popup) |

> The permission round-trip is **decoupled from the agent path** (`shelfApi.agent.resolvePermission` / `agent:permission-request`): `web.fetch` is gated at the resource layer in main, not the provider tool-confirm. See `contracts/app-tool-bridge` (`web.fetch`) and `context/web-tab` web-tab#2.

## updater (`shelfApi.updater`)

| Method | Shape |
|--------|-------|
| `check()` | invoke `update:check` |
| `download()` | invoke `update:download` |
| `install()` | invoke `update:install` |
| `onStatus(cb(status: UpdateStatus))` | recv `update:status` → unsubscribe fn. `UpdateStatus` see `src/shared/types.ts` |

## pm (`shelfApi.pm`)

PM Agent control + read-only stream mirror.

| Method | Shape |
|--------|-------|
| `send(message)` | invoke `pm:send` |
| `stop()` | invoke `pm:stop` |
| `history()` | invoke `pm:history` → `PmMessage[]` (see `src/shared/types.ts`) |
| `clear()` | invoke `pm:clear` |
| `compact()` | invoke `pm:compact` → `{ kept: number, removed: number }` |
| `syncState(state)` | send `pm:sync-state` (renderer → main state mirror) |
| `setAwayMode(on: boolean)` | invoke `pm:away-mode` |
| `getAwayMode()` | invoke `pm:away-mode-get` → `boolean` |
| `setActive(on: boolean)` | invoke `pm:set-active` |
| `getActive()` | invoke `pm:active-get` → `boolean` |
| `listModels(baseURL)` | invoke `pm:list-models` → `PmListModelsResult` (see `src/shared/types.ts`) |
| `onAwayMode(cb(on: boolean))` | recv `pm:away-mode` → unsubscribe fn |
| `onActive(cb(on: boolean))` | recv `pm:active` → unsubscribe fn |
| `onActiveError(cb(reason: string))` | recv `pm:active-error` → unsubscribe fn |
| `onStream(cb(chunk: PmStreamChunk))` | recv `pm:stream` → unsubscribe fn. `PmStreamChunk` see `src/shared/types.ts` |

> `pm:escalation-respond` is a declared constant in `IPC` but is not currently exposed in preload nor handled in main (vestigial).

## agent (`shelfApi.agent`)

Renderer↔backend session bridge. Wire payloads crossing these channels are render primitives, not provider vocabulary — see `contracts/agent-wire-protocol`. Most push channels carry `(tabId, payload)`.

Renderer → main (invoke / send):

| Method | Shape |
|--------|-------|
| `init(tabId, cwd, connection, provider, sessionId?, opts?)` | invoke `agent:init` |
| `send(tabId, prompt, images?, prefs?)` | invoke `agent:send`. `prefs`: `{ model?, effort?, permissionMode?, configEdit?: { key: 'model'|'effort'|'permissionMode', value }, clientMsgId? }` |
| `stop(tabId)` | invoke `agent:stop` |
| `cancelQueued(tabId, clientMsgId)` | invoke `agent:cancel-queued` (drop a not-yet-running queued message) |
| `destroy(tabId)` | invoke `agent:destroy` |
| `resolvePermission(tabId, toolUseId, allow: boolean, scope?: 'once'|'session')` | invoke `agent:resolve-permission` |
| `resolvePicker(tabId, pickerId, payload)` | invoke `agent:resolve-picker`. `payload`: `{ answers: Array<string|string[]> } | { cancelled: true }` |
| `storeCredential(tabId, key)` | invoke `agent:store-credential` |
| `clearCredential(tabId)` | invoke `agent:clear-credential` |
| `checkAuth(tabId)` | invoke `agent:check-auth` |
| `fetchTaskOutput(tabId, taskId)` | invoke `agent:read-task-output` → background task's full remote output |
| `stopTask(tabId, taskId)` | invoke `agent:stop-task` |

Main → renderer (push; all return an unsubscribe fn):

| Method | Channel / payload |
|--------|-------------------|
| `onMessage(cb(tabId, msg))` | `agent:message` — render-primitive `AgentMessage` (see `src/shared/types.ts`) |
| `onStream(cb(tabId, chunk))` | `agent:stream` — incremental reply text |
| `onStatus(cb(tabId, status))` | `agent:status` — busy/idle |
| `onPlan(cb(tabId, { content }))` | `agent:plan` |
| `onBackgroundTasks(cb(tabId, event))` | `agent:background-tasks` — `TaskEvent` (turnId-less) |
| `onQueue(cb(tabId, items))` | `agent:queue` — server-owned `AgentQueueItem[]` snapshot |
| `onConnectionHealth(cb(tabId, health))` | `agent:connection-health` — `ConnectionHealth` from heartbeat RTT |
| `onPermissionRequest(cb(tabId, req))` | `agent:permission-request` |
| `onPickerRequest(cb(tabId, req))` | `agent:picker-request` |
| `onCapabilities(cb(tabId, caps))` | `agent:capabilities` — provider capabilities |
| `onAuthRequired(cb(tabId, provider: string))` | `agent:auth-required` |
| `onInitStatus(cb(tabId, status))` | `agent:init-status` |
