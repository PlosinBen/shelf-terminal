---
type: contract
title: Agent Routing
related:
  - contracts/agent-wire-protocol
  - contracts/app-tool-bridge
  - context/agent-config-flow
---

# Agent Routing

The control / routing messages that drive an agent session across the three hops `renderer → main → agent-server`: slash commands, structured config edits, picker resolve, the app-tool bridge, skill reload, stop, and queue cancel. Conversation content (reply / fold_* / stream / error) and execution status are specified in `contracts/agent-wire-protocol`. This doc covers the imperative / control surface only.

## Topology

Three transports, each with its own framing — a control action threads through all three:

- **renderer → main** — IPC `invoke` on the `IPC.AGENT_*` channels (`src/shared/ipc-channels.ts`). Payloads are `{ tabId, ... }`; handlers in `src/main/agent/index.ts` look up the per-tab `session.backend` (an `AgentBackend`, `src/main/agent/types.ts`) and call a method.
- **main → agent-server** — newline-delimited JSON on the child's stdin. `RemoteProcess.sendLine(obj)` in `src/main/agent/remote.ts` writes one `IncomingMessage` (`agent-server/exec.ts`, the `IncomingMessage` interface) per line. The `rl.on('line')` switch dispatches by `type`.
- **agent-server → main** — newline-delimited JSON on stdout, the `OutgoingMessage` union (`agent-server/providers/types.ts`). Execution status/permission control may carry `executionId`; conversation content is session-scoped; RPC responses use `requestId`; transport-level messages such as `pong` and `app_tool` bypass the execution dispatcher.

Authoritative type names: `IncomingMessage` (`agent-server/exec.ts`), `OutgoingMessage` / `PickerResolvePayload` / `QueryInput` / `ServerBackend` (`agent-server/providers/types.ts`), `AgentBackend` / `AgentQueryOptions` / `AgentEvent` (`src/main/agent/types.ts`).

## Canonical input

Source types and factory/validators: `src/shared/agent-input.ts` (`AgentInputMessage`,
`AgentInputRequest`, `createAgentInputMessage`, `validateAgentInputMessage`).
Callers supply source/content/attachments/reply requirements; the factory validates structure,
defaults attachments to `[]` and reply requirements to `none`, then allocates `msgId`.
Existing messages are revalidated at process boundaries without allocating a replacement ID.

```ts
agent.send(tabId, {
  inputMessage: {
    msgId: '<factory UUID>',
    source: { kind: 'agent-view' },
    content: 'original text',
    attachments: [],
    replyRequirement: 'none',
  },
});
```

- `source` is `{kind:'agent-view'}`, `{kind:'telegram'}`, or
  `{kind:'agent', agentViewId, displayName}`. Agent identity is stable and the name is a
  send-time snapshot; it does not require provider metadata. The Agent source shape does
  not itself expose Agent messaging tools. Renderer IPC accepts only `agent-view` sources;
  trusted entry adapters own provenance, not the factory or Sender.
- Renderer source labels read persisted metadata only: Telegram inputs show `Telegram`,
  Agent inputs show `From <displayName>` using the send-time snapshot. Ordinary Agent View
  inputs and legacy rows without source metadata remain unlabelled. This presentation does
  not add provider metadata, authorization or automatic reply routing.
- `content` preserves original whitespace. Whitespace-only text without attachments is invalid;
  attachment-only messages are valid. Attachment metadata is retained, not format-restricted.
- `replyRequirement` is `none` or `brief-plain-text`. Unknown values are rejected. Telegram
  selects the latter explicitly; Sender never infers it from source. Shared execution guidance
  is applied at each provider's model-input boundary, without mutating the message or appending
  invented arguments to slash commands. Telegram plain-text output and chunking remain enforced
  separately; model compliance is not guaranteed.
- Target `tabId`, cwd, connection, session/execution identities and provider prefs are not message
  fields. Config edits use `{configEdit:{key,value}}` instead of `inputMessage`, never both.
- Existing queue snapshots remain `{clientMsgId,state}`. Renderer submissions project the factory
  `msgId` into `clientMsgId`; internal callers use the same correlation but retain direct history
  mirroring. Main filters mirrored inputs from renderer optimistic projection, not from receipt
  processing. All message Callers use the common Sender; submission and execution completion
  have separate lifetimes. There is no retry, cross-execution deduplication or durable-queue guarantee.
- User history may carry optional `inputMessage` metadata alongside its existing render fields.
  Preview images remain renderer-local; old rows without metadata remain readable.

### Submission result

Authoritative types/constants: `src/shared/agent-submission.ts`. Message submission returns
`Promise<SubmissionResult>` as a serializable Result, not an execution-completion boolean:

```ts
{ ok: true }
// or
{ ok: false, error: { code: 'confirmation_timeout', message: '...' } }
```

Success means an exec queue snapshot contained this View's `msgId`, either queued or directly
running. Writing the send frame alone is not confirmation. Success does not promise provider
completion, a final reply or persistence. Main keeps consuming execution control after returning;
session content remains independently deliverable, including after execution idle.

Error codes are `invalid_input`, `target_missing`, `forbidden`, `duplicate_submission`,
`not_sent`, `unconfirmed` and `confirmation_timeout`. Callers handle errors and presentation;
Sender does not emit a UI alert, Telegram notification or delegation state change.
`unconfirmed` means the execution ended after write without a queue receipt; a ten-second wait
without receipt returns `confirmation_timeout`. These errors may mean delivery occurred, so they
must not authorize automatic resend or deletion of a possibly accepted optimistic input.
An active duplicate id is rejected without executing again; it does not erase the original input.
This active-id guard is not a general idempotency guarantee.

Timeout ends only the submission wait, not execution. Late receipts notify registered consumers
independently without rewriting the earlier Result. Receipt tracking ends at execution settlement
or logical View closure; timers are cleared. Internal projections remain filtered for the reader's
lifetime. Renderer callers use existing snapshots to reconcile optimistic chips; error notices
are historical submission errors, not a new persistent delivery-state UI.

The compatibility `configEdit` input retains its queued execution-completion boolean, without a
message id or receipt wait. Status-bar selections use independent session control instead.

## Slash command dispatch

**Direction**: renderer → main → agent-server (no dedicated channel — rides the normal send path).

Slash is NOT a control message of its own. A typed `/cmd args` flows as ordinary prompt text and the provider decides whether to interpret the prefix (`agent-config-flow#2`). The renderer only short-circuits unparametrised `OPTIONED_SLASHES` (`/model` `/effort` `/permission`) into an inline picker (`agent-config-flow#3`); everything else is sent as text.

- renderer → main: `IPC.AGENT_SEND` with `{ tabId, inputMessage }`, whose `content` is `/help` (no `configEdit`). Uploaded attachments are inside `inputMessage`; preview data URLs stay renderer-local.
- main → agent-server: `sendLine({ type: 'send', executionId, provider, inputMessage, cwd, sessionId, clientMsgId?, appId, ... })`. A fresh exec must complete configuration initialization before this frame is sent; input carries no model/effort/permission overrides.
- The provider calls `parseSlashPrefix(input.prompt)` inside `query()`; output comes back as a normal `fold_markdown` wire message (`errorMessage` on failure), not a distinct response type.

### Copilot `/clear`

Copilot exposes one Shelf-owned reset command even though the ACP command catalog does not advertise it:

| Input | Provider effect |
|-------|-----------------|
| `/clear` | Do not call `session/prompt`. Emit `lastSdkSessionId:null`, clear session context usage, establish and initialize a new ACP session, persist its ID, publish final capabilities, emit a system confirmation, then settle idle. |
| `/clear PROMPT` | Complete the same replacement first, then call `session/prompt` once with `PROMPT` as the replacement session's first input. |
| `/new` or `/reset` | Emit a visible error directing the user to `/clear`; do not create or prompt a session. These names are filtered out of Copilot capabilities. |

The Copilot capabilities command list filters `clear`, `new`, and `reset` from the provider snapshot, then appends the canonical `{ name:'clear', description:'Clear conversation context' }` entry. Replacement failure emits no success confirmation, and a trailing prompt is never dispatched to the old session. The dispatcher, main process, and renderer do not parse these provider-specific command names.

Replacement pointer order is:

```text
context_patch { lastSdkSessionId: null }
context_patch { lastSdkSessionId: <replacement ACP session id> }
```

The provider captures confirmed session configuration before the first patch and force-applies it to the replacement before reporting success. A persisted empty replacement session uses the ordinary reconnect restore and exact missing-session recovery rules; there is no clear-specific reconnect route.

## Uploaded attachments

**Direction**: renderer → main → agent-server → provider.

Agent image/file input uses the shared `AgentAttachment` contract in `src/shared/types.ts`.
Images pasted/dropped in AgentView are uploaded through the same connector path as Terminal file
uploads, landing under the target cwd's `.tmp/shelf/`; the resulting absolute target-host path is
sent as an `AgentImageAttachment`. Renderer history can keep base64 data URLs for local preview,
but provider-bound `attachments` must contain target-host readable paths.

`AgentAttachment` fields:

| Field | Type | Notes |
|-------|------|-------|
| `kind` | `'image' \| 'file'` | Provider conversion usually filters `kind:'image'`; file attachments may be surfaced later per provider. |
| `path` | `string` | Absolute path readable by the agent-server/provider process on the target host. |
| `displayPath` | `string` | Cwd-relative or short-form path for renderer chips/history. |
| `name` | `string` | Original/sanitized display filename. |
| `mimeType` | `string?` | Required by `AgentImageAttachment`; fallback hint for providers that need inline bytes. |
| `size` | `number?` | Byte size when known. |

Provider mapping examples: Codex app-server maps `AgentImageAttachment` to
`{ type:'localImage', path }`; ACP providers read `path` and produce ACP
`{ type:'image', data:<base64>, mimeType }`; Claude reads `path` and produces its SDK base64 image
block. `data:image/...` must not be sent to Codex app-server as `image.url`; legacy data URL images
are fail-loud at that provider boundary.

The shared inline-image reader used by Claude and ACP identifies PNG, JPEG, GIF, and WebP from
target-file signatures before choosing the MIME type. For unrecognized bytes it preserves the
attachment's `mimeType`, or defaults to `image/png` when that hint is empty or absent. This does
not decode, transcode, validate, or reject other image formats. Codex continues to use the uploaded
path. Clipboard/file classification and renderer previews still follow their existing metadata.

## Session configuration control

Types/constants: `src/shared/agent-config-control.ts`; keys: `src/shared/config-ack.ts`.
Status-bar picker selections invoke `agent.configure(tabId, request)` through `IPC.AGENT_CONFIGURE`:

```ts
{ requestId: '<control UUID>', key: 'effort', value: 'high' }
// stdin
{ type: 'configure_session', requestId: '<control UUID>', key: 'effort', value: 'high' }
// stdout (progress, then one terminal result)
{ type: 'configure_session_result', requestId: '<control UUID>', key: 'effort', value: 'high', state: 'deferred' }
```

Progress is `deferred` or `applying`, forwarded over `IPC.AGENT_CONFIG_CONTROL`. The invoke resolves
with `ConfigControlUpdate`: terminal `confirmed`, `rejected`, or `uncertain`, with optional `error`.
Deferred means accepted, not applied. The server's 30-second confirmation timeout starts at applying,
not while waiting for current work. Main times out a missing initial/applying response after 35 seconds;
deferred waiting has no execution-duration timeout. Neither layer automatically resends.

One unresolved direct control is allowed per View, across all keys. A provider chooses live application
or an idle boundary. Both reserve a control slot outside message snapshots and prevent the next queued
execution from starting until settled; message FIFO is unchanged. Direct controls create no message or
execution IDs, pending chips, timeline entries, or execution status. Same-value no-ops still settle.
Only confirmed capabilities update display and `Project.agentViews[sessionId].prefs` through the normal
serialized mutation path. `confirmedPrefs` retains its provider-specific explicit-patch semantics.
Confirmation does not promise that currently running inference adopted the setting.
Stop rejects controls whose setters have not started, with an explicit not-applied error.
Controls received during stop are rejected; message dispatch waits for provider stop to settle.
An already invoked setter still reports its actual confirmed/rejected/uncertain outcome.

Definite pre-mutation rejection leaves the session usable. Unknown mutation outcome retains queued
inputs and blocks subsequent execution starts until reconnect; it does not imply rollback. The UI
requires active work to finish/stop and queued inputs to be cancelled before its Reconnect action,
avoiding silent discard. Reconnect never resends the failed control. Main binds pending calls to the
initialized process/epoch; renderer ignores stale IDs and progress after terminal results.

Picker origin is explicit: status-bar selections use this control contract; no-argument `/model`,
`/effort`, or `/permission` pickers retain their command name and submit `/<command> <value>` as a
factory-created ordinary message, including queue projection/history. Native permission capability
descriptors choose the picker options without exposing provider types to renderer.

The supported compatibility input `{configEdit:{key,value}}` still uses `send` / `QueryInput.configEdit`
as a no-prompt FIFO execution with provider acknowledgement. It is not the status-bar route.
Ordinary input never carries settings overrides (`agent-config-flow#14`, `agent-config-flow#16`).

## picker_request (agent-server → renderer)

**Direction**: agent-server → main → renderer.

Provider asks the renderer to show a multi-question interactive form (Claude `AskUserQuestion`; the Copilot elicitation path was native-SDK-only and is not yet rebuilt on ACP — deferred, see `agent-ui#3`).

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
- main: handled directly in `remote.ts`'s stdout reader (NOT the execution dispatcher) — `handleAppTool(op, args)` (`src/main/agent/app-tool.ts`) runs it against client-owned resources (skills-store) and returns `{ ok, data?, error? }`.
- main → agent-server: `sendLine({ type: 'app_tool_result', requestId, ok, data?, error? })`. The switch calls `resolveAppToolResult(requestId, { ok, data, error })`, unblocking `callMain`'s Promise.

## reload_skills

**Direction**: renderer/main-internal → agent-server (fire-and-forget). App-level skills changed on disk and were already projected/synced to the consumption path; tell live provider sessions to re-scan without reconnect.

- trigger: main's skills-changed pipeline (`onSkillsChanged` → subscriber in `src/main/agent/index.ts`) calls `session.backend.reloadSkills()` per live session.
- main → agent-server: `sendLine({ type: 'reload_skills' })`. The switch fans out to every instantiated backend: `for (const b of backends.values()) void b.reloadSkills?.()` — best-effort, no-op without a live session, effective from the session's next execution.

No payload beyond `type`. (`reloadSkills?()` exists on both `AgentBackend` and `ServerBackend`.) `ServerBackend.reloadSkills()` returns `{ reloaded, ok, error? }` so the agent-server can surface the result (see `skills_reloaded`); `reloaded:false` = no live session (no line emitted).

## skills_reloaded

**Direction**: agent-server → main → renderer (the result of a `reload_skills`). Session-scoped (NO executionId) — emitted by the agent-server `reload_skills` handler via the **base send** after each backend's `reloadSkills()` resolves, so it bypasses `wrapSendForExecution` and is executionId-less by construction.

- agent-server → main: `{ type: 'skills_reloaded', ok: boolean, error?: string }`, only when `reloaded` (no-op reloads emit nothing).
- routing: the host-process dispatcher routes it by type (before the executionId check) to a session-level `onSkillsReloaded` sink — its callback in `index.ts` captures `tabId` (the agent-server child is 1:1 with a tab, like `task_event` / `queue`).
- main synthesizes an `AGENT_MESSAGE` for that tab, reusing the existing renderer rendering: `ok` → `{ type:'system', content:'Skills reloaded' }` (a divider line); `!ok` → `{ type:'error', content:'Skills reload failed: …' }` (fail-loud).

This is the user-visible feedback for skill hot-reload (`context/skills` skills#4) — without it the re-scan is silent and the user can't tell their edit reached the running agent.

## skills_reloaded and content delivery

`skills_reloaded` rides **session-scoped delivery**, as do all conversation-content events. The host dispatcher routes `message` / `stream` / `error` to the tab's `onSessionEvent` sink before execution lookup. `executionId` routes status/permission control only; settlement never gates content. See `architecture/agent-execution` for the full model. Conversation-content event shapes remain in `contracts/agent-wire-protocol`.

## stop_task

**Direction**: renderer → main → agent-server (fire-and-forget). Stop a running background task (`DECISIONS #72`).

- renderer → main: `IPC.AGENT_STOP_TASK` `{ tabId, taskId }` → `session.backend.stopTask?.(taskId)`.
- main → agent-server: `sendLine({ type: 'stop_task', taskId })` → `void activeBackend.stopTask?.(taskId)`. No direct reply — the resulting `task_notification` (status `'stopped'`) flows back through the normal `task_event` lane and updates the task card (so the stop's effect is observed via `AGENT_BACKGROUND_TASKS`, not a stop_task ack).

## stop (interrupt execution)

**Direction**: renderer → main → agent-server (fire-and-forget). ESC: clear the waiting queue + interrupt the running execution.

- renderer → main: `IPC.AGENT_STOP` `{ tabId }` → `stopSession(tabId)` → `backend.stop()`.
- main → agent-server: `sendLine({ type: 'stop' })`. The switch runs `sendQueue.clear()` (drops all not-yet-running sends and re-emits the queue snapshot) then `handleStop()` → `activeBackend.stop()`. Provider-native stoppability remains internal and never surfaces to the renderer (`agent-config-flow#2`).

## queue (send-queue snapshot)

**Direction**: agent-server → main → renderer. Session-level (NO `executionId`). agent-server owns the send queue; it serializes executions one-at-a-time and emits the FULL ordered snapshot on every change (enqueue / start-running / complete / cancel).

- agent-server → main: `OutgoingMessage` `{ type: 'queue', items: AgentQueueItem[] }` (no `executionId` — `wrapSendForExecution` must not stamp it). Routed via the session-level `onQueue` sink in `remote.ts`, never the execution-control lane.
- main → renderer: `IPC.AGENT_QUEUE`, carrying the `AgentQueueItem[]` for the renderer to mirror.

There is no `enqueue` control message — the renderer eager-sends every `{ type: 'send' }` and agent-server's `createSendQueue` owns timing/ordering. `clientMsgId` projects the factory message id and is echoed in each snapshot item.

## cancel_queued

**Direction**: renderer → main → agent-server → main → renderer, correlated RPC.
Authoritative constants/result: `QUEUE_CANCEL` / `QueueCancelResult` in
`src/shared/agent-queue-cancel.ts`.

- renderer → main: `IPC.AGENT_CANCEL_QUEUED` `{ tabId, clientMsgId }`; invokes
  `backend.cancelQueued(clientMsgId)` and returns its result. Missing target rejects.
- main → agent-server: `{type:'cancel_queued',requestId,clientMsgId}`.
- agent-server → main: `{type:'cancel_queued_result',requestId,clientMsgId,status}`.
  `status` is `cancelled` (removed queued item and terminated its control reader),
  `running` (cannot cancel queued work that has started), or `not_found` (no matching
  waiting/running item). The result does not stop running provider execution.
- main validates response correlation/status and returns `{status}`. Ten seconds without
  confirmation rejects without claiming cancellation, retrying or changing queue state.
  The response registration is removed on timeout/write failure; a late result does not
  retroactively turn the failed call into success. Legacy frames without requestId still
  cancel in exec but receive no RPC response.

The renderer's central event handler marks a pending chip `cancelling`, disables repeat
clicks and preserves its content. A removal snapshot may precede the RPC response; while
cancellation is pending, absence alone does not discard the local content or report a
vanished-input anomaly. Only `cancelled` removes the chip. A running snapshot promotes
the retained input normally, even before the cancellation response, so history remains
complete and repeated snapshots do not duplicate it. `not_found` or RPC failure clears
the pending-cancel flag, retains any remaining input and displays an error; it does not
pretend the input was cancelled. This single-item contract does not change bulk stop/ESC.

## get_capabilities (RPC)

**Direction**: main → agent-server → main (requestId-matched RPC, tab open).

Listed for completeness — the capabilities request/response that seeds the status bar. Not renderer-initiated as a control action; `remote.ts` issues it from `getCapabilities()`.

Production probes read the latest explicit prefs/custom models from main's
canonical Project boundary. The pending probe is shared with first input on the
same exec incarnation; idle wake, auth reconnect and dispatcher exec replacement
invalidate completion. Failure prevents delivery and retains typed recovery;
successful automatic initialization republishes capabilities and input readiness.
This lifecycle stores only identity/promise state, not a duplicate prefs cache.

- main → agent-server: `sendLine({ type: 'get_capabilities', provider, cwd, sessionId, customModels?, intent?, requestId })`. `intent` is `AgentPrefs`: `{ model?, effort?, permissionMode?, nativeMode?, nativePermission?, nativeApproval? }`. Agent-server loads provider-matched restore context, binds a context-aware session sink, and passes both boundaries to `gatherCapabilities`.
- Copilot first establishes the final session: `session/resume` when `sessionCapabilities.resume` is advertised, otherwise `session/load` when `loadSession` is true; load replay content is suppressed while metadata is retained. A capabilities-time `session/new` emits `context_patch` immediately. It then hydrates advertised controls, validates all saved selections, and sends each present saved value sequentially as model → effort → native mode → native permission, including values equal to the restored snapshot. Native mode completes when `session/set_mode` succeeds and the observed mode equals the request; an already matching restored mode needs no redundant update, while a differing mode requires an authoritative update. Intermediate provider updates do not publish capabilities. The RPC resolves only with the final confirmed snapshot; validation, setter, mismatch, timeout, or teardown rejects initialization instead. This authoritative apply runs once per newly established final session, not on later capabilities reads that reuse the initialized session.
- agent-server → main: `OutgoingMessage` `{ type: 'capabilities', requestId, error?, ...ProviderCapabilities, currentModel?, currentEffort?, currentPermissionMode? }`, matched in `proc.onResponse`. Native current values remain inside `permissionControl.mode.currentValue`, `permissionControl.permission.currentValue`, and `permissionControl.approval.currentValue`. Unsolicited `capabilities` without `requestId` may be execution-scoped or execution-less; both route through the session event sink to `IPC.AGENT_CAPABILITIES` (`agent-config-flow#9`). There is no separate `confirmed_config` message.

Restore failure is not generally a fresh-session signal. Copilot starts a replacement session only when the ACP error uses the resource-not-found code and names the exact persisted session id. It clears the stale pointer, persists the replacement id, and keeps the existing recovery notice; all other restore failures remain fail-loud. Saved project selections are applied after either successful restore or replacement.

## Other control messages (one-line each)

Same renderer→main→agent-server pattern; payloads are self-describing:

- **store_credential** — `IPC.AGENT_STORE_CREDENTIAL` `{ tabId, key }` → `sendLine({ type: 'store_credential', provider, key, requestId })` → reply `{ type: 'credential_stored', requestId, ok, error? }`.
- **clear_credential** — `IPC.AGENT_CLEAR_CREDENTIAL` `{ tabId }` → `sendLine({ type: 'clear_credential', provider, requestId })` → reply `{ type: 'credential_cleared', requestId, ok, error? }`.
- **read_task_output** — `IPC.AGENT_READ_TASK_OUTPUT` `{ tabId, taskId }` → `sendLine({ type: 'read_task_output', provider, taskId, requestId })` → reply `{ type: 'task_output', requestId, content?, error? }`.
- **clear_context** — internal `backend.clearContext()` → `sendLine({ type: 'clear_context', sessionId })`; agent-server deletes persisted context + calls `resetSession` on every backend. No reply.
- **ping / pong** — heartbeat. `remote.ts` writes `{ type: 'ping', seq }` on an interval; agent-server replies `{ type: 'pong', seq }`. Transport-level (RTT + liveness lease + idle-shutdown watchdog), never the execution dispatcher. See `context/connection-health`.


## Codex native configuration

`CONFIG_EDIT_KEYS` is the shared key authority. Codex advertises Mode, Permission profile, and Approval descriptors plus model-specific effort options. Model/profile/mode options originate in app-server; Approval exposes native `untrusted`, `on-request`, `never`, filtered by managed requirements. A structured granular value is display-only `Custom`, with no selectable synthetic value.

`collaborationMode/list` requires an explicit empty `params: {}` object; omitting `params` is rejected by the pinned app-server parser. `configRequirements/read` has no params in the protocol, so this is a method-specific requirement.

Initialization enables experimental API, loads native options, establishes the final thread using the existing restore context, and applies saved selections before publishing capabilities. Absent prefs do not receive Shelf defaults. Config edits use `thread/settings/update`; matching `thread/settings/updated` and successful RPC confirm changes in either arrival order. Same confirmed values are no-ops. Start/resume omits collaboration mode, so the first explicit Mode apply may establish that value via successful RPC when a same-value update produces no notification. Mode payload retains effective model/effort and selects built-in instructions for the requested mode.

Failed or timed-out updates publish no success or preferences. An uncertain settings snapshot blocks subsequent settings edits and turns until reconnect. Model changes that invalidate the current effort are rejected without changing either value. Native snapshots are not replayed as canonical permission overrides on every turn.
