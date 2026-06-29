---
type: contract
title: Agent Routing
related:
  - contracts/agent-wire-protocol
  - contracts/app-tool-bridge
  - context/agent-config-flow
---

# Agent Routing

The control / routing messages that drive an agent session across the three hops `renderer → main → agent-server`: slash commands, structured config edits, picker resolve, the app-tool bridge, skill reload, stop, and queue cancel. Conversation-content events (reply / fold_* / status / stream) are NOT here — see `contracts/agent-wire-protocol`. This doc covers the imperative / control surface only.

## Topology

Three transports, each with its own framing — a control action threads through all three:

- **renderer → main** — IPC `invoke` on the `IPC.AGENT_*` channels (`src/shared/ipc-channels.ts`). Payloads are `{ tabId, ... }`; handlers in `src/main/agent/index.ts` look up the per-tab `session.backend` (an `AgentBackend`, `src/main/agent/types.ts`) and call a method.
- **main → agent-server** — newline-delimited JSON on the child's stdin. `RemoteProcess.sendLine(obj)` in `src/main/agent/remote.ts` writes one `IncomingMessage` (`agent-server/index.ts`, the `IncomingMessage` interface) per line. The `rl.on('line')` switch dispatches by `type`.
- **agent-server → main** — newline-delimited JSON on stdout, the `OutgoingMessage` union (`agent-server/providers/types.ts`). Per-turn events carry a `turnId` envelope; control responses are matched by `requestId`; a few are transport-level (`pong`, `app_tool`) and never reach the turn dispatcher.

Authoritative type names: `IncomingMessage` (`agent-server/index.ts`), `OutgoingMessage` / `PickerResolvePayload` / `QueryInput` / `ServerBackend` (`agent-server/providers/types.ts`), `AgentBackend` / `AgentQueryOptions` / `AgentEvent` (`src/main/agent/types.ts`).

## Slash command dispatch

**Direction**: renderer → main → agent-server (no dedicated channel — rides the normal send path).

Slash is NOT a control message of its own. A typed `/cmd args` flows as ordinary prompt text and the provider decides whether to interpret the prefix (`agent-config-flow#2`). The renderer only short-circuits unparametrised `OPTIONED_SLASHES` (`/model` `/effort` `/permission`) into an inline picker (`agent-config-flow#3`); everything else is sent as text.

- renderer → main: `IPC.AGENT_SEND` with `{ tabId, prompt: "/help", images?, model?, effort?, permissionMode?, clientMsgId? }` (no `configEdit`).
- main → agent-server: `sendLine({ type: 'send', turnId, provider, prompt: "/help", cwd, sessionId, model?, effort?, permissionMode?, clientMsgId?, appId, ... })`.
- The provider calls `parseSlashPrefix(input.prompt)` inside `query()`; output comes back as a normal `fold_markdown` wire message (`errorMessage` on failure), not a distinct response type.

## Config edit (model / effort / permission)

**Direction**: renderer → main → agent-server, as a structured no-prompt turn.

Picker / status-bar config changes do NOT build a `/model X` string — they send a structured `configEdit` that converges on the provider's `applyConfigEdit` (`agent-config-flow#5`). `key` is the picker/prefs key; note `/permission` maps to `permissionMode`.

- renderer → main: `IPC.AGENT_SEND` with `{ tabId, prompt: '', configEdit: { key: 'model' | 'effort' | 'permissionMode', value: string }, clientMsgId? }`.
- main → agent-server: `sendLine({ type: 'send', turnId, provider, prompt: '', cwd, sessionId, configEdit: { key, value }, ... })` — `prompt` is empty; agent-server's `handleSend` treats `!!msg.configEdit` as the config-edit branch and skips `applyPrefDiff` (the edit IS the change).
- The provider applies it and emits a `system` divider + a fresh `capabilities` wire message; the renderer persists from capabilities, never optimistically.

Field type: `configEdit?: { key: 'model' | 'effort' | 'permissionMode'; value: string }` — identical on `AgentQueryOptions`, `IncomingMessage`, and `QueryInput`.

Silent per-message prefs (`model` / `effort` / `permissionMode` on every send) are a SEPARATE mechanism: the orchestrator diff-detects them per session and calls `ServerBackend.setModel/setEffort/setPermissionMode` only on change, with no divider (`agent-config-flow#6`). They are NOT `configEdit`.

## picker_request (agent-server → renderer)

**Direction**: agent-server → main → renderer.

Provider asks the renderer to show a multi-question interactive form (Claude `AskUserQuestion`, Copilot elicitation — `agent-ui#3`).

- agent-server → main: `OutgoingMessage` `{ type: 'picker_request', id, prompts: Array<{ question, header?, multiSelect, options: Array<{ label, description?, preview? }>, inputType?: 'text'|'number'|'integer', currentValue?: string | string[] }> }`. `id` is provider-minted (Claude uses the toolUseId; Copilot mints a uuid).
- main: `parseRemoteMessage` validates + reshapes into `AgentEvent` `{ type: 'picker_request', id, prompts }`, forwarded over `IPC.AGENT_PICKER_REQUEST` to the renderer (drops the whole message if any prompt is malformed — never renders half a form).

## resolve_picker

**Direction**: renderer → main → agent-server (the answer to a `picker_request`).

- renderer → main: `IPC.AGENT_RESOLVE_PICKER` with `{ tabId, pickerId, payload }` where `payload` is a `PickerResolvePayload`: `{ answers: Array<string | string[]> }` (index-aligned with the request's `prompts[]`; `string[]` for multi-select) OR `{ cancelled: true }`. Handler calls `session.backend.resolvePicker(pickerId, payload)`.
- main → agent-server: `sendLine({ type: 'resolve_picker', pickerId, payload })`. The switch calls `activeBackend.resolvePicker?.(pickerId, payload)`, which resolves the provider's internal Promise for that picker.

`PickerResolvePayload` is defined in `agent-server/providers/types.ts` and duplicated (intentionally, to avoid a cross-module dep) in `src/main/agent/types.ts`.

## resolve_permission (tool-use permission)

**Direction**: round-trip. Request agent-server → renderer; answer renderer → main → agent-server.

Separate from picker (`agent-ui#3` — the "Allow/Deny/Allow and remember" strings are app-owned, the resolve shape differs).

- request: `OutgoingMessage` `{ type: 'permission_request', toolUseId, toolName, input }` → `AgentEvent` of the same shape → `IPC.AGENT_PERMISSION_REQUEST`.
- answer: `IPC.AGENT_RESOLVE_PERMISSION` `{ tabId, toolUseId, allow, scope? }`. Note the wire form is richer than the IPC form: in `remote.ts` the `canUseTool` callback result becomes `sendLine({ type: 'resolve_permission', toolUseId, allow: behavior === 'allow', message: deny ? message : undefined, scope: allow ? scope : undefined })`. `scope` is `'once' | 'session'`.

## app_tool (app-tool bridge)

**Direction**: agent-server → main → agent-server (request/result). Transport-level — does NOT go to the renderer. Full design in `contracts/app-tool-bridge`.

A provider's in-process bridge tool calls `callMain(op, args)` (`agent-server/app-tool-client.ts`), which emits a request matched by `requestId`.

- agent-server → main: `OutgoingMessage` `{ type: 'app_tool', requestId, op: string, args: Record<string, unknown> }`. `op` is `resource.verb` (e.g. `app_skill.list`, `app_skill.update`).
- main: handled directly in `remote.ts`'s stdout reader (NOT the turn dispatcher) — `handleAppTool(op, args)` (`src/main/agent/app-tool.ts`) runs it against client-owned resources (skills-store) and returns `{ ok, data?, error? }`.
- main → agent-server: `sendLine({ type: 'app_tool_result', requestId, ok, data?, error? })`. The switch calls `resolveAppToolResult(requestId, { ok, data, error })`, unblocking `callMain`'s Promise.

## reload_skills

**Direction**: renderer/main-internal → agent-server (fire-and-forget). App-level skills changed on disk and were already projected/synced to the consumption path; tell live provider sessions to re-scan without reconnect.

- trigger: main's skills-changed pipeline (`onSkillsChanged` → subscriber in `src/main/agent/index.ts`) calls `session.backend.reloadSkills()` per live session.
- main → agent-server: `sendLine({ type: 'reload_skills' })`. The switch fans out to every instantiated backend: `for (const b of backends.values()) void b.reloadSkills?.()` — best-effort, no-op without a live session, effective from the session's next turn.

No payload beyond `type`. (`reloadSkills?()` exists on both `AgentBackend` and `ServerBackend`.) `ServerBackend.reloadSkills()` returns `{ reloaded, ok, error? }` so the agent-server can surface the result (see `skills_reloaded`); `reloaded:false` = no live session (no line emitted).

## skills_reloaded

**Direction**: agent-server → main → renderer (the result of a `reload_skills`). Session-scoped (NO turnId) — emitted by the agent-server `reload_skills` handler via the **base send** after each backend's `reloadSkills()` resolves, so it bypasses `wrapSendForTurn` and is turnId-less by construction.

- agent-server → main: `{ type: 'skills_reloaded', ok: boolean, error?: string }`, only when `reloaded` (no-op reloads emit nothing).
- routing: the host-process dispatcher routes it by type (before the turnId check) to a session-level `onSkillsReloaded` sink — its callback in `index.ts` captures `tabId` (the agent-server child is 1:1 with a tab, like `task_event` / `queue`).
- main synthesizes an `AGENT_MESSAGE` for that tab, reusing the existing renderer rendering: `ok` → `{ type:'system', content:'Skills reloaded' }` (a divider line); `!ok` → `{ type:'error', content:'Skills reload failed: …' }` (fail-loud).

This is the user-visible feedback for skill hot-reload (`context/skills` skills#4) — without it the re-scan is silent and the user can't tell their edit reached the running agent.

## skills_reloaded ⟂ content delivery (turnId-scoping)

`skills_reloaded` rides the same **session-scoped delivery** that all conversation content now uses: the host-process dispatcher routes `message` / `stream` / `error` events to a session sink (`onSessionEvent` → `dispatchEvent` by tab id) **before** the turnId check, so content is never gated on (or dropped by) turn id. turn id routes only `status` / control events (turn-end, busy/idle, permission). See `architecture/agent-turn` for the full model. Conversation-content event SHAPES stay in `contracts/agent-wire-protocol`; this is only their host-side routing.

## stop_task

**Direction**: renderer → main → agent-server (fire-and-forget). Stop a running background task (`DECISIONS #72`).

- renderer → main: `IPC.AGENT_STOP_TASK` `{ tabId, taskId }` → `session.backend.stopTask?.(taskId)`.
- main → agent-server: `sendLine({ type: 'stop_task', taskId })` → `void activeBackend.stopTask?.(taskId)`. No direct reply — the resulting `task_notification` (status `'stopped'`) flows back through the normal `task_event` lane and updates the task card (so the stop's effect is observed via `AGENT_BACKGROUND_TASKS`, not a stop_task ack).

## stop (interrupt turn)

**Direction**: renderer → main → agent-server (fire-and-forget). ESC: clear the waiting queue + interrupt the running turn.

- renderer → main: `IPC.AGENT_STOP` `{ tabId }` → `stopSession(tabId)` → `backend.stop()`.
- main → agent-server: `sendLine({ type: 'stop' })`. The switch runs `sendQueue.clear()` (drops all not-yet-running sends and re-emits the queue snapshot) then `handleStop()` → `activeBackend.stop()`. Per-turn `stoppable` is provider-internal and never surfaces to the renderer (`agent-config-flow#2`).

## queue (send-queue snapshot)

**Direction**: agent-server → main → renderer. Session-level (NO `turnId`). agent-server owns the send queue; it serializes turns one-at-a-time and emits the FULL ordered snapshot on every change (enqueue / start-running / complete / cancel).

- agent-server → main: `OutgoingMessage` `{ type: 'queue', items: AgentQueueItem[] }` (no `turnId` — `wrapSendForTurn` must not stamp it). Routed via the session-level `onQueue` sink in `remote.ts`, never the per-turn lane.
- main → renderer: `IPC.AGENT_QUEUE`, carrying the `AgentQueueItem[]` for the renderer to mirror.

There is no `enqueue` control message — the renderer eager-sends every `{ type: 'send' }` and agent-server's `createSendQueue` owns timing/ordering. `clientMsgId` (renderer-minted at submit) is the correlation key echoed in each snapshot item.

## cancel_queued

**Direction**: renderer → main → agent-server (fire-and-forget). Drop one not-yet-running queued send by `clientMsgId`; no-op once it's running.

- renderer → main: `IPC.AGENT_CANCEL_QUEUED` `{ tabId, clientMsgId }` → `session.backend.cancelQueued?.(clientMsgId)`.
- main → agent-server: `sendLine({ type: 'cancel_queued', clientMsgId })`. The switch calls `sendQueue.cancel(clientMsgId)` (only when `clientMsgId` is a string), which removes the item and re-emits the `queue` snapshot. A cancel that didn't cleanly remove an item logs an anomaly to stderr (`cancel-running` benign, `cancel-unknown` a real desync) — never silent.

## get_capabilities (RPC)

**Direction**: main → agent-server → main (requestId-matched RPC, tab open).

Listed for completeness — the capabilities request/response that seeds the status bar. Not renderer-initiated as a control action; `remote.ts` issues it from `getCapabilities()`.

- main → agent-server: `sendLine({ type: 'get_capabilities', provider, cwd, sessionId, customModels?, intent?, requestId })`. `intent` = renderer's saved prefs `{ model?, effort?, permissionMode? }`, so session-stateful providers (Copilot) seed their `current*` closures before reporting back.
- agent-server → main: `OutgoingMessage` `{ type: 'capabilities', requestId, error?, ...ProviderCapabilities, currentModel?, currentEffort?, currentPermissionMode? }`, matched in `proc.onResponse`. Mid-turn unsolicited `capabilities` (no `requestId`) also exist — those go through `parseRemoteMessage` → `IPC.AGENT_CAPABILITIES` (see `agent-config-flow#3`).

## Other control messages (one-line each)

Same renderer→main→agent-server pattern; payloads are self-describing:

- **store_credential** — `IPC.AGENT_STORE_CREDENTIAL` `{ tabId, key }` → `sendLine({ type: 'store_credential', provider, key, requestId })` → reply `{ type: 'credential_stored', requestId, ok, error? }`.
- **clear_credential** — `IPC.AGENT_CLEAR_CREDENTIAL` `{ tabId }` → `sendLine({ type: 'clear_credential', provider, requestId })` → reply `{ type: 'credential_cleared', requestId, ok, error? }`.
- **read_task_output** — `IPC.AGENT_READ_TASK_OUTPUT` `{ tabId, taskId }` → `sendLine({ type: 'read_task_output', provider, taskId, requestId })` → reply `{ type: 'task_output', requestId, content?, error? }`.
- **clear_context** — internal `backend.clearContext()` → `sendLine({ type: 'clear_context', sessionId })`; agent-server deletes persisted context + calls `resetSession` on every backend. No reply.
- **ping / pong** — heartbeat. `remote.ts` writes `{ type: 'ping', seq }` on an interval; agent-server replies `{ type: 'pong', seq }`. Transport-level (RTT + liveness lease + idle-shutdown watchdog), never the turn dispatcher. See `context/connection-health`.
