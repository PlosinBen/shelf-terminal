---
type: contract
title: IPC Channels
related:
  - contracts/agent-wire-protocol
  - contracts/external-url-intent
  - contracts/persistence-formats
  - contracts/process-memory
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
| `onInitPhase(cb(tabId, phase))` | recv `pty:init-phase`; phase is `'initializing' \| 'init-script' \| 'ready' \| 'failed'` → unsubscribe fn. See `contracts/terminal-control`. |

## project (`shelfApi.project`)

| Method | Shape |
|--------|-------|
| `getAll()` | invoke `project:get-all` → readonly canonical `Project[]` (see `src/shared/projects.ts`) |
| `add(input)` | invoke `project:add` with id-less `ProjectCreateInput` → main-owned canonical `Project` |
| `update(project)` | invoke `project:update` with a complete canonical `Project` |
| `delete(projectId)` | invoke `project:delete` → `ProjectDeleteResult`; rejection means config did not commit. A committed delete may return `{ cleanupPending: true, leftover: { targetPath, reason } }` when target history cleanup needs current-session retry. |
| `retryCleanup(projectId)` | invoke `project:retry-cleanup` → `ProjectDeleteResult`; reuses the in-memory cleanup snapshot and never resends delete |
| `reorder(sourceId, targetId)` | invoke `project:reorder` with opaque project ids |
| `validateDirs()` | invoke `project:validate-dirs` → invalid project ids; main reads repository state |
| `listSecretKeys(projectId)` | invoke `project:secrets-list` → `string[]` KEY names (values NEVER cross back to renderer) |
| `setSecret(projectId, key, value)` | invoke `project:secret-set` (encrypt + persist to the side-car; rejects reserved keys) |
| `deleteSecret(projectId, key)` | invoke `project:secret-delete` |
| `copySecrets(fromId, toId)` | invoke `project:secrets-copy` after durable child creation |
| `secretKeyTier()` | invoke `secret:key-tier` → `'os-backed' \| 'local-key'` (drives honest disclosure copy) |

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
| `worktreeRemove(connection, cwd, worktreePath)` | invoke `git:worktree-remove`; runs non-force Git worktree removal |
| `migrateNote(connection, baseCwd, worktreeCwd, notePaths)` | invoke `git:migrate-note` → `{ ok, migrated?, error? }`; create-time base→child feature-note move for selected feature-note paths |
| `restoreNotes(connection, baseCwd, worktreeCwd, featureNoteDir)` | invoke `git:restore-notes` → `{ ok, migrated?, error? }`; close-time child→base restore through the child's stored directory snapshot |
| `deleteBranch(connection, cwd, branch, force?)` | invoke `git:delete-branch` → `{ ok, error? }` |
| `branchMerged(connection, cwd, target, branch)` | invoke `git:branch-merged` → `{ merged, aheadCount }` |
| `listFeatureNotes(connection, cwd, featureNoteDir)` | invoke `git:list-feature-notes` → `{ ok: true, notes: FeatureNoteInfo[] } \| { ok: false, error: string }`; missing/empty directories are successful empty lists, operational failures remain explicit |

## worktree (`shelfApi.worktree`)

| Method | Shape |
|--------|-------|
| `finishMergeBack(payload)` | invoke `worktree:finish-merge-back` → `FinishMergeBackResult`; `payload = { connection, featureCwd, baseCwd, baseBranch, featureBranch }`; outcome is `'merged' \| 'busy' \| 'non-ff' \| 'feature-dirty' \| 'base-dirty' \| 'error'` |
| `onProposeCreate(cb(payload))` | recv `worktree:propose-create` → `{ projectId, branch?, notePaths?: string[] }`; renderer focuses `projectId`, then opens the New Worktree dialog only |
| `onProposeFinish(cb(payload))` | recv `worktree:propose-finish` → `{ projectId }`; renderer focuses `projectId`, then opens the Finish gate only |

Renderer-local worktree completion uses the event bus, not IPC: `worktree-finish-completed` carries `{ subProjectId, parentProjectId, featureBranch, targetBranch }` after every close step succeeds.

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

## find (`shelfApi.find`)

In-page text search for DOM-based tabs (agent / web), which have no xterm `SearchAddon`. Drives Chromium's native `webContents.findInPage` in main; terminal tabs keep searching through the xterm addon in the renderer. `SearchBar` picks the path by active tab type.

| Method | Shape |
|--------|-------|
| `query(text, { forward: boolean, findNext: boolean })` | send `window:find` (`findNext:false` = fresh search, `true` = step to next/prev) |
| `stop()` | send `window:stop-find` (clears highlight + selection) |
| `onResult(cb({ activeMatchOrdinal, matches, finalUpdate }))` | recv `window:find-result` → unsubscribe fn (forwarded `found-in-page` for the match counter) |

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
| `setLocked(name, locked: boolean)` | invoke `skills:set-locked` (badge-only: `notifyRendererSkillsChanged`, no re-project) |
| `setDisabled(name, disabled: boolean)` | invoke `skills:set-disabled` (full `onSkillsChanged` pipeline — drops/re-adds the skill from the projected tree) |
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

## configBackup (`shelfApi.configBackup`)

App-Level Config Backup & Copy（Skills + MCP）。Backup = selected live items → 本機的 `backup/<app-instance-id>` 分支；Import = pinned source revision 的 selected items → live。See `context/config-backup`、`architecture/config-backup`。authoritative 型別在 `src/shared/config-backup.ts`。

| Method | Shape |
|--------|-------|
| `getBinding()` | invoke `config-backup:get-binding` → `ConfigBackupBinding \| null` |
| `saveSettings({ remoteUrl, machineLabel })` | invoke `config-backup:save-settings` → `void`。純寫檔、**零驗證**（兩欄全空 = 刪檔清除）；錯誤延到 Back up 才報 |
| `list()` | invoke `config-backup:list` → `BackupListResult`（binding + live items + `intent` 預勾 + `suggestedLabel` = sanitize 過的 hostname）。只讀本機 intent，不碰 git/網路 → 秒開、離線可用 |
| `run(selectedIds)` | invoke `config-backup:run` → `BackupRunResult`。成功含 `pushed/branch/itemCount`；失敗 `reason: 'not-bound' \| 'validation' \| 'remote'`，validation 可帶 `itemId`。selected whole items replace remote 同名 item，未選 remote content 不動 |
| `listSources(remoteUrl)` | invoke `config-backup:list-sources` → `BackupSource[]`（transient URL 的所有備份分支，own 優先）；每筆含 process-local opaque `sourceRevision`，pin 到本次 fetch 的 commit |
| `listImportItems(remoteUrl, sourceRevision)` | invoke `config-backup:list-import-items` with object payload → `ImportListResult`（`items` 含 validity + `new/replace-local` impact；top-level category 問題在 `issues`）|
| `applyImport(remoteUrl, sourceRevision, selectedIds)` | invoke `config-backup:apply-import` with object payload → `ImportApplyResult`。成功回 canonical changed counts/ids；失敗帶 `phase: source \| validation \| apply \| rollback`、optional `itemId`、`rollback` status |

## web (`shelfApi.web`)

Manage the shared web session + the app-global `web.fetch` permission popup. See `context/web-tab`. The `<webview>` itself uses the `persist:web` partition directly (it is not an IPC channel); these methods are the management + permission surface only.

| Method | Shape |
|--------|-------|
| `listSessions()` | invoke `web:list-sessions` → `WebSessionEntry[]` (`{ domain, cookieCount }`, grouped by registrable domain; see `src/shared/web-session.ts`) |
| `deleteSession(domain)` | invoke `web:delete-session` (log out of a registrable domain) |
| `listGrants()` | invoke `web:list-grants` → `WebGrantsByProject` (`{ [projectId]: origin[] }`) |
| `revokeGrant(projectId, origin)` | invoke `web:revoke-grant` |
| `onPermissionRequest(cb(req))` | recv `web:permission-request` → unsubscribe fn. `req`: `WebPermissionMeta & { requestId }` (`{ requestId, projectId, origin, registrableDomain, method }`) |
| `resolvePermission(requestId, decision: 'once'|'always'|'deny')` | invoke `web:permission-resolve` |
| `onPermissionClose(cb(requestId))` | recv `web:permission-close` → unsubscribe fn (resolved elsewhere — Telegram / timeout — dismiss the local popup) |
| `onBrowserOpenRequest(cb(req))` | recv `web:browser-open-request` → unsubscribe fn. `req`: `BrowserOpenMeta & { requestId }` (`{ requestId, projectId, url, origin, registrableDomain, reason? }`) |
| `resolveBrowserOpen(requestId, decision: 'open'|'deny')` | invoke `web:browser-open-resolve` |
| `onBrowserOpenClose(cb(requestId))` | recv `web:browser-open-close` → unsubscribe fn (resolved elsewhere — timeout — dismiss the local popup) |
| `onOpenTab(cb(projectId, url))` | recv `web:open-tab` → unsubscribe fn. Post-approval: open a Web tab in `projectId` navigated to `url` |

> The permission round-trip is **decoupled from the agent path** (`shelfApi.agent.resolvePermission` / `agent:permission-request`): `web.fetch` is gated at the resource layer in main, not the provider tool-confirm. See `contracts/app-tool-bridge` (`web.fetch`) and `context/web-tab` web-tab#2.
>
> `browser_open` (`web:browser-open-*`) is the agent-opens-a-login-tab tool: a per-call **Open/Deny** popup (never remembered — a separate, stricter round-trip than the `web:permission-*` grant path), then `web:open-tab` opens the tab. See `contracts/app-tool-bridge` (`web.open`) and `context/web-tab` web-tab#8.

## externalUrlIntent (`shelfApi.externalUrlIntent`)

App-wide external default-app decision gate. Source, request, destination, decision, limits, and terminal framing are authoritative in `contracts/external-url-intent`.

| Method | Shape |
|--------|-------|
| `request(input)` | invoke `external-url-intent:submit` with `ExternalUrlIntentInput` → `'copy' \| 'open' \| 'cancel'` |
| `resolve(requestId, decision)` | invoke `external-url-intent:resolve` with `{ requestId, decision }` |
| `onRequest(cb(request))` | recv `external-url-intent:request` with `ExternalUrlIntentRequest` → unsubscribe fn |
| `onClose(cb(requestId))` | recv `external-url-intent:close` with `{ requestId }` → unsubscribe fn |

Only renderer-owned producers use `request`; main-owned renderer navigation, provider login, and PTY producers call the same main gate directly. Renderer queues presentation state but does not validate URLs or execute clipboard/default-app effects.

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
| `startLogin(tabId)` | invoke `agent:start-login` — start interactive device-flow login (Copilot). Prompt/result arrive via `onLoginPrompt`/`onLoginDone`. See `context/agent-providers` #10 |
| `cancelLogin(tabId)` | invoke `agent:cancel-login` — kill a running interactive login |
| `fetchTaskOutput(tabId, taskId)` | invoke `agent:read-task-output` → background task's full remote output |
| `stopTask(tabId, taskId)` | invoke `agent:stop-task` |
| `getMemoryUsage()` | invoke `agent:memory-usage-current` → cached `ProcessMemorySummary \| null`; hydration only, never samples or recomputes. See `contracts/process-memory`. |

Main → renderer (push; all return an unsubscribe fn):

| Method | Channel / payload |
|--------|-------------------|
| `onMessage(cb(tabId, msg))` | `agent:message` — render-primitive `AgentMessage` (see `src/shared/types.ts`) |
| `onStream(cb(tabId, chunk))` | `agent:stream` — incremental reply text |
| `onStatus(cb(tabId, status))` | `agent:status` — busy/idle |
| `onPlan(cb(tabId, { content }))` | `agent:plan` |
| `onBackgroundTasks(cb(tabId, event))` | `agent:background-tasks` — `TaskEvent` (executionId-less) |
| `onQueue(cb(tabId, items))` | `agent:queue` — server-owned `AgentQueueItem[]` snapshot |
| `onConnectionHealth(cb(tabId, health))` | `agent:connection-health` — `ConnectionHealth` from heartbeat RTT |
| `onPermissionRequest(cb(tabId, req))` | `agent:permission-request` |
| `onPickerRequest(cb(tabId, req))` | `agent:picker-request` |
| `onCapabilities(cb(tabId, caps))` | `agent:capabilities` — provider capabilities |
| `onAuthRequired(cb(tabId, provider: string))` | `agent:auth-required` |
| `onLoginPrompt(cb(tabId, prompt))` | `agent:login-prompt` — device-flow `{ provider, verificationUri, userCode, prefilledUri }` (session-level). Main also opens the URL locally |
| `onLoginDone(cb(tabId, result))` | `agent:login-done` — `{ provider, ok, cancelled?, error? }` |
| `onInitStatus(cb(tabId, status))` | `agent:init-status` |
| `onMemoryUsage(cb(summary))` | `agent:memory-usage` — complete app-wide `ProcessMemorySummary`, unconditionally published every 30 seconds. See `contracts/process-memory`. |
