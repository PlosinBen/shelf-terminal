---
type: contract
title: Agent Wire Protocol
related:
  - contracts/agent-routing
  - context/agent-ui
  - context/agent-config-flow
---

# Agent Wire Protocol

The line-delimited JSON message stream from `agent-server` → main process: each message is one `OutgoingMessage` discriminated by `type`, optionally wrapped in a `WireEnvelope` (`turnId` / `startsTurn`) that routes per-turn events; a small set of session-level lanes are turnId-exempt. The authoritative definition is `OutgoingMessage` in `agent-server/providers/types.ts`; main parses each variant in `parseRemoteMessage` (`src/main/agent/remote.ts`) and dispatches to renderer IPC in `src/main/agent/index.ts`. This contract describes the envelope, the renderer-facing render primitives, and the turnId-exempt lanes.

## Envelope — `WireEnvelope`

Source: `WireEnvelope` in `agent-server/providers/types.ts`. Stamped onto every per-turn message by `wrapSendForTurn` in agent-server; providers never see it (carried via closure).

| Field | Type | Notes |
|-------|------|-------|
| `turnId` | `string?` | Routing key. Main's `createTurnDispatcher` (`src/main/agent/turn-dispatcher.ts`) routes the message to the per-turn `AsyncGenerator` registered under this id. Lifecycle messages and session-level lanes omit it intentionally. A non-lifecycle message missing `turnId` is logged and dropped. |
| `startsTurn` | `boolean?` | Only meaningful on `type: 'message'`. Marks the first message of a server-initiated (auto-resume) turn so the renderer's `buildTurns` opens a fresh turn block (these turns have no anchoring `user` message). See agent-config-flow#1, DECISIONS #69. |
| `parentToolUseId` | `string?` | Only on `type: 'message'` (msgType `reply` \| `fold_*`). Set when the message was emitted BY A SUBAGENT (Task/Agent tool); value is the outer Agent tool_use's `msgId`. `buildTurns` nests the message under that card instead of the main list (absent = top-level / main agent). claude threads the SDK `parent_tool_use_id` (incl. the tool_result re-emit); a subagent is also dropped from the background-tasks panel. See background-tasks#7. |

Main mints `turnId` (`t-${randomUUID().slice(0,8)}`) at `query()` entry and registers the turn **before** the `send` reaches agent-server, so early events have a destination. Generator ends after the first `status` with `state:'idle'` (plus buffered tail events).

```jsonc
{ "type": "message", "turnId": "t-1a2b3c4d", "msgId": "msg_01", "msgType": "reply", "content": "Hello" }
```

## Render-primitive messages — `type: 'message'`

The renderer-facing timeline entries. One wire `type: 'message'`, discriminated by `msgType`. Main's `buildAgentMessagePayload` translates each into the canonical `AgentMessage` union (`src/shared/types.ts`); the renderer upserts by `msgId`. Unknown `msgType` → main returns null and drops the message.

`msgId` is the universal upsert key (provider-minted). Stream chunks (see [stream](#stream--type-stream)) share a `msgId` with their eventual finalize so the renderer accumulates them into one entry. For `fold_*` tool messages providers typically reuse the SDK `toolUseId` as `msgId` (pending → completed upsert).

The renderer-side `AgentMessage` adds a renderer-only `user` variant (never emitted by providers) and an optional `streaming?` flag (set only while `reply` / `fold_text` receive deltas). `plan` is **not** in this union — it is a state side-channel (see [plan](#plan-side-channel--type-plan)).

### Inline variants — `reply` / `note` / `system` / `error`

Pure inline content, single `content` field.

| Field | Type |
|-------|------|
| `type` | `'message'` |
| `msgId` | `string` |
| `msgType` | `'reply'` \| `'note'` \| `'system'` \| `'error'` |
| `content` | `string` |

Rendering (per agent-ui#5): `reply` = assistant markdown reply (streams); `note` = one-line dim italic, renderer draws the leading `▸` marker (provider sends pure content); `system` = framework/SDK inline notice (config-edit dividers land here); `error` = inline red provider-business-layer error.

```jsonc
{ "type": "message", "turnId": "t-1a2b3c4d", "msgId": "msg_07", "msgType": "note", "content": "Reading config files" }
```

### Foldable card variants — `fold_text` / `fold_code` / `fold_markdown` / `fold_diff`

Collapsible cards sharing the `FoldBase` header (`src/shared/types.ts`). Differ only in `body` shape and how the renderer renders the body. `errorMessage` present ⇒ card treated as failed (red banner, force-expanded regardless of display setting); `body` may be absent (pure failure) or present (failed-with-partial-output).

Common fields (all four):

| Field | Type | Notes |
|-------|------|-------|
| `type` | `'message'` | |
| `msgId` | `string` | |
| `msgType` | `'fold_text'` \| `'fold_code'` \| `'fold_markdown'` \| `'fold_diff'` | |
| `label` | `string` | Required — main drops the card if missing. |
| `subtitle` | `string?` | Full string; renderer CSS-truncates + `title=` tooltip. |
| `errorMessage` | `string?` | Set ⇒ failed card, force-expanded. |

Body shape per variant:

| `msgType` | `body` shape | Render |
|-----------|--------------|--------|
| `fold_text` | `{ content: string; tone?: 'muted' }?` | wrapped plain text (reasoning/prose); streams; `tone:'muted'` renders dim |
| `fold_code` | `{ content: string }?` | monospace `<pre>`, markdown intentionally NOT parsed (shell stdout, file contents) |
| `fold_markdown` | `{ content: string }?` | rendered markdown (slash output, MCP rich text, fenced code) |
| `fold_diff` | `{ diff: { oldString: string; newString: string } }?` | side-by-side diff |

```jsonc
{ "type": "message", "turnId": "t-1a2b3c4d", "msgId": "tool_abc",
  "msgType": "fold_diff", "label": "Edit src/app.ts", "subtitle": "src/app.ts",
  "body": { "diff": { "oldString": "const a = 1", "newString": "const a = 2" } } }
```

```jsonc
{ "type": "message", "turnId": "t-1a2b3c4d", "msgId": "tool_def",
  "msgType": "fold_code", "label": "Bash", "subtitle": "npm run typecheck",
  "errorMessage": "exit 1", "body": { "content": "Type error on line 4" } }
```

## stream — `type: 'stream'`

Incremental delta chunks for a streaming `reply` / `fold_text`. Per-turn (carries `turnId`). The renderer upserts by `msgId` onto a placeholder that the eventual finalize `message` (same `msgId`) replaces.

| Field | Type | Notes |
|-------|------|-------|
| `type` | `'stream'` | |
| `msgId` | `string` | Ties the chunk to its finalize `message`. |
| `streamType` | `'text'` \| `'thinking'` | Wire vocabulary kept for back-compat: `'text'` finalizes as `reply`, `'thinking'` as `fold_text`. |
| `content` | `string` | Delta chunk (append). |

```jsonc
{ "type": "stream", "turnId": "t-1a2b3c4d", "msgId": "msg_07", "streamType": "text", "content": "partial " }
```

## status — `type: 'status'`

Per-turn busy-state + cost/usage. `state:'idle'` closes the turn generator. Forwarded to `IPC.AGENT_STATUS`.

| Field | Type | Notes |
|-------|------|-------|
| `type` | `'status'` | |
| `state` | `'streaming'` \| `'idle'` | |
| `model` | `string?` | Per-turn resolved model — display is intent-driven via capabilities, not this (agent-config-flow#4). |
| `sessionId` | `string?` | |
| `costUsd` / `inputTokens` / `outputTokens` / `numTurns` | `number?` | |
| `contextUsage` | `StatusSegment?` | `{ text, severity? }` — see `agent-server/providers/types.ts`. |
| `rateLimits` | `StatusSegment[]?` | |

## capabilities — `type: 'capabilities'`

Dual-purpose: a one-shot RPC response carrying `requestId` (matched in main's `onResponse` map), **or** an unsolicited mid-turn update (model/mode change, model promotion). Full field shape is `Partial<ProviderCapabilities>` plus `currentModel` / `currentEffort` / `currentPermissionMode` — see `ProviderCapabilities` in `agent-server/providers/types.ts`. Forwarded to `IPC.AGENT_CAPABILITIES`; drives renderer status bar + pref persistence (agent-config-flow#3).

| Field | Type | Notes |
|-------|------|-------|
| `type` | `'capabilities'` | |
| `requestId` | `string?` | Present ⇒ RPC response; absent ⇒ unsolicited broadcast. |
| `error` | `string?` | |
| ...`ProviderCapabilities` | — | `models`, `permissionModes`, `effortLevels`, `slashCommands`, `authMethod?`, `authRequired?` |
| `currentModel` / `currentEffort` / `currentPermissionMode` | `string?` | |

## plan side-channel — `type: 'plan'`

State update ("current plan = X"), NOT a timeline entry. Replace-semantics; empty `content` hides the panel. Forwarded to `IPC.AGENT_PLAN` → `agentTabStore.currentPlan` (never the message timeline). See agent-ui#1.

| Field | Type |
|-------|------|
| `type` | `'plan'` |
| `content` | `string` |

## picker_request — `type: 'picker_request'`

Agent-initiated multi-question structured form (Claude `AskUserQuestion`, Copilot elicitation). Forwarded to `IPC.AGENT_PICKER_REQUEST`. Renderer resolves via `AGENT_RESOLVE_PICKER` IPC with a `PickerResolvePayload` (`{ answers: Array<string | string[]> }` index-aligned with `prompts[]`, or `{ cancelled: true }`). Full shape in `agent-server/providers/types.ts`; main validates each prompt in `parseRemoteMessage` (drops the whole message on a malformed prompt).

| Field | Type | Notes |
|-------|------|-------|
| `type` | `'picker_request'` | |
| `id` | `string` | Provider-minted; echoed back via resolve. |
| `prompts` | `Array<{ question; header?; multiSelect; options[]; inputType?; currentValue? }>` | one entry per question |
| `prompts[].options[]` | `{ label; description?; preview? }` | |
| `prompts[].inputType` | `'text'` \| `'number'` \| `'integer'` \| `undefined` | set ⇒ free-text input |

See agent-ui#3 for the channel-ownership rationale (kept separate from permission).

## permission_request — `type: 'permission_request'`

Per-turn tool-permission prompt. Does NOT enter the event queue — the dispatcher fires the turn's `permissionHandler` directly (initiating the `canUseTool` round-trip). Forwarded to `IPC.AGENT_PERMISSION_REQUEST`; renderer answers via `AGENT_RESOLVE_PERMISSION`.

| Field | Type |
|-------|------|
| `type` | `'permission_request'` |
| `toolUseId` | `string` |
| `toolName` | `string` |
| `input` | `Record<string, unknown>` |

## error — `type: 'error'`

Per-turn (carries `turnId`) transport/business error. Logged to file in main, then forwarded to the renderer as an inline `error` message (`IPC.AGENT_MESSAGE` with `{ type:'error', content }`).

| Field | Type |
|-------|------|
| `type` | `'error'` |
| `error` | `string` |

## auth_required — `type: 'auth_required'`

Per-turn signal that the remote lost credentials. Forwarded to `IPC.AGENT_AUTH_REQUIRED`.

| Field | Type |
|-------|------|
| `type` | `'auth_required'` |
| `provider` | `string` |

---

## Session-level lanes (turnId-exempt)

These are routed by `createTurnDispatcher` **before** the `turnId` check, into dedicated session sinks — they must NOT carry a `turnId` (`wrapSendForTurn` is exempted for them), because a backgrounded task or session-scoped snapshot outlives any single turn and would otherwise be dropped as "unknown turn" once the turn deregisters. See DECISIONS #69, message-queue-ownership.

### task_event — `type: 'task_event'`

Background-task update. Provider-agnostic. Routed via the `onTaskEvent` sink → `IPC.AGENT_BACKGROUND_TASKS`. Body is a `TaskEvent` (`src/shared/types.ts`).

| Field | Type | Notes |
|-------|------|-------|
| `type` | `'task_event'` | |
| `kind` | `'started'` \| `'updated'` \| `'progress'` \| `'done'` \| `'snapshot'` | |
| `task` | `NormalizedTask?` | present for started/updated/progress/done |
| `tasks` | `NormalizedTask[]?` | present for `snapshot` (authoritative full list, reconciles drift) |

`NormalizedTask` = `{ id; type; label; status; command?; summary?; done; error? }` (see `src/shared/types.ts`).

```jsonc
{ "type": "task_event", "kind": "progress",
  "task": { "id": "bash_1", "type": "shell", "label": "build", "status": "running",
            "command": "npm run build", "summary": "compiling…", "done": false } }
```

### queue — `type: 'queue'`

Server-owned send-queue snapshot (agent-server serializes turns and owns the queue). Full ordered snapshot of in-flight client sends, re-emitted on every change. Routed via the `onQueue` sink → `IPC.AGENT_QUEUE`; the renderer mirrors it (optimistic chips reconciled against this authoritative list). Non-array `items` is logged and ignored (an empty snapshot would wrongly drop chips).

| Field | Type | Notes |
|-------|------|-------|
| `type` | `'queue'` | |
| `items` | `AgentQueueItem[]` | each `{ clientMsgId: string; state: 'queued' \| 'running' }` (`src/shared/types.ts`) |

### auth_login_prompt / auth_login_done — interactive device-flow login

Emitted while an interactive `copilot login` (OAuth device flow) runs. Session-level because login is triggered by an IPC command (`agent:start-login`), NOT a `send` — it runs outside any turn. Routed by the dispatcher to `onSessionEvent` → main → `IPC.AGENT_LOGIN_PROMPT` / `IPC.AGENT_LOGIN_DONE`. On `auth_login_prompt`, main ALSO opens the URL in the user's LOCAL system browser (`shell.openExternal`) — essential when the agent-server runs on a remote host. Provider-side: `agent-server/providers/copilot/login.ts`. See `context/agent-providers` agent-providers#10.

| Field | Type | Notes |
|-------|------|-------|
| `type` | `'auth_login_prompt'` | |
| `provider` | `string` | |
| `verificationUri` | `string` | e.g. `https://github.com/login/device` |
| `userCode` | `string` | e.g. `1E5E-903B` |
| `prefilledUri` | `string` | `verificationUri` + `?user_code=` (what main opens) |

| Field | Type | Notes |
|-------|------|-------|
| `type` | `'auth_login_done'` | terminal outcome; success = login process exit 0 |
| `provider` | `string` | |
| `ok` | `boolean` | |
| `cancelled` | `boolean?` | true when killed via `agent:cancel-login` |
| `error` | `string?` | present on `ok:false` (non-cancel) |

Inbound commands: `start_login` (`{ provider, cwd, sid }`) and `cancel_login` (`{ provider, sid }`) — see `agent-server/exec.ts`.

### turn_started — `type: 'turn_started'`

Server-initiated turn announcement carrying a provider-minted `turnId` (via the envelope). The dispatcher registers that turnId **synchronously** on receipt (permissionless handler) and hands the turn's generator to the `onServerTurn` sink — used when a backgrounded task finishes and the SDK auto-resumes to write a real reply that has no live foreground turn. The subsequent `message` carries `startsTurn:true`. See agent-config-flow#1, DECISIONS #69.

| Field | Type |
|-------|------|
| `type` | `'turn_started'` |
| `turnId` | `string` (in envelope) |

---

## Lifecycle messages (turnId-exempt, out-of-band)

Emitted outside any turn. Some are one-shot RPC responses keyed `<type>:<requestId>` in the dispatcher's `onResponse` map; others are signals. Defined in `OutgoingMessage` (`agent-server/providers/types.ts`):

| `type` | Key fields | Routing |
|--------|-----------|---------|
| `ready` | — | resolves `awaitReady()` once at boot |
| `pong` | `seq?` | heartbeat ack (RTT → `ConnectionHealth`, `IPC.AGENT_CONNECTION_HEALTH`) |
| `credential_stored` | `requestId; ok; error?` | RPC response |
| `credential_cleared` | `requestId; ok; error?` | RPC response |
| `task_output` | `requestId; content?; error?` | RPC response — full background-task output |
| `app_tool` | `requestId; op; args` | server→main bridge-tool request; main replies `app_tool_result` |
| `log` | `level: error\|warn\|info\|debug; tag; msg` | diagnostic → main's `@shared/logger` at `level` (main applies the filter). See below. |
| `context_patch` | `patch: Partial<PersistedContext>` | intercepted in `agent-server/index.ts`, NOT forwarded to main |

### `log` — agent-server has no independent observability

agent-server can't use `@shared/logger` (it writes a file via electron `app.getPath`, and there is no electron in agent-server) and its **stdout is this wire**, so it routes every diagnostic to main as a `log` message instead of writing anywhere itself. `serverLog(level, tag, msg, ...args)` (`agent-server/server-logger.ts`) flattens args to text at the source (where `Error` objects are still intact — they'd serialize to `{}` over the wire) and emits `{type:'log', ...}`; main's reader (`remote.ts`) calls `log[level](tag, msg)`, so the **level filter lives in main** (single source of truth) — agent-server emits every level and main drops what's below `currentLevel`. Benign per-event diagnostics use `debug` (silent at the default `error` level).

The ONLY things still on the child's **stderr**: a log emitted before the sink is wired (early boot fallback) and a fatal/death path (Node's default uncaught dump; the idle-shutdown self-exit). main logs raw stderr at `error` — now rare and meaningful, since routine diagnostics no longer go there. See `context/agent-core` agent-core#9.

(`capabilities` is also requestId-keyed when used as an RPC response — documented above under its render section since it doubles as a mid-turn broadcast.)

---

## Dispatch addressing — `sid` vs `turnId` vs payload `sessionId`

When a single per-host dispatcher multiplexes many sessions (see `architecture/agent-dispatch`), the wire gains one new routing dimension. THREE distinct identifiers now coexist and MUST keep distinct names — they are not interchangeable:

| Name | Scope | Meaning |
|------|-------|---------|
| `turnId` | per turn | Routes per-turn events to their turn reader (unchanged; see the Envelope above). Main mints it per `send`. |
| `sid` | per session | **NEW envelope field.** The app/tab session key = the routing dimension the dispatcher demuxes on. Its value is the same app session key that already rides as `send.sessionId`. A distinct NAME so it can never collide with a payload `sessionId`. |
| `sessionId` | payload-internal, provider-owned | The provider's SDK session id (e.g. Claude `msg.session_id`) inside `status`, and the context-store key inside `send` / `clear_context`. NEVER an envelope routing key — the dispatcher never routes on it. |

`sid` is added ONLY as an envelope/routing field; it never replaces or renames the payload `sessionId`. A message can legitimately carry both (its routing `sid` and, inside, a provider `sessionId`).

## Boundary 1 — main ↔ dispatcher

Over the transport (secure channel / subsystem / container / same-machine stdio). Same line-delimited JSON framing as the single-tier protocol above, plus a `sid` dimension, session lifecycle, and a **host-level** heartbeat (one per host, not per session).

**main → dispatcher**

| `type` | Key fields | Meaning |
|--------|-----------|---------|
| `open_session` | `sid; provider; cwd; initScript?; projectId?; env?` | Ensure an execution unit for `sid`. Answered by a relayed `ready{sid}` (= `session_ready`) or `session_down`. Opening an already-open `sid` replaces the stale channel first (see `agent-core#11`). `env` = the project's resolved env map (plain + decrypted secret): the dispatcher is per-HOST so per-project env can't ride its own process env — it travels here and is applied to the per-session exec proc (re-applied on reconnect). See `context/project-env#2`. |
| `close_session` | `sid` | Session closed → dispatcher disposes that execution unit (a NORMAL closure → it self-reaps escaped detached tasks). |
| `ping` | `seq` | Host-level heartbeat, ONE per host (no `sid`); replaces the per-session ping. |
| per-session commands | + `sid` | `send`, `stop`, `cancel_queued`, `resolve_permission`, `resolve_picker`, `stop_task`, `get_capabilities`, `store_credential`, `clear_credential`, `clear_context`, `read_task_output`, `reload_skills`, `app_tool_result` — each gains `sid`, routed to that session's execution unit, payloads otherwise UNCHANGED. |

**dispatcher → main**

| `type` | Key fields | Meaning |
|--------|-----------|---------|
| `ready` | — | Dispatcher process up (no `sid`); gates nothing per-session. |
| `session_down` | `sid; reason; willReconnect` | Execution unit for `sid` exited (crash / hang / normal). Main fails that session's in-flight turns loudly, then marks it recovering if `willReconnect` (a relayed `ready{sid}` follows once reconnected) or disconnected if not (backoff exhausted). |
| `pong` | `seq` | Host heartbeat ack (no `sid`). Host-level health = RTT / miss on THIS. |
| existing per-turn / session events | + `sid` | Every existing `OutgoingMessage` (stream, message, status, queue, task_event, skills_reloaded, capabilities, credential_*, task_output, permission_request, picker_request, plan, auth_required, turn_started, error, log) is stamped with `sid` and **passed through OPAQUELY** — the dispatcher forwards without parsing. |

`session_ready` is not a separate message: the execution unit stamps its own `ready` with its `sid`, and the dispatcher relays it. `get_capabilities` is per-`sid` and comes AFTER the session is ready (`open_session` → ready → `get_capabilities(sid)`); it is answered by the execution unit's runtime, keeping the dispatcher thin.

## Boundary 2 — dispatcher ↔ execution unit

Local stdio on the host. The execution unit is a session-addressed harness (see `architecture/agent-dispatch`), so this boundary ALSO carries `sid`: every per-session command/event carries it, the unit routes inbound to its session map and stamps outbound events with their `sid`, and the dispatcher relays to/from main. In the currently deployed isolated shape the map holds one entry, so `sid` is redundant-but-harmless there; the point is the harness is uniformly session-addressed.

This boundary additionally carries the **cache side-channel** — serviced locally by the dispatcher, NOT relayed to main (peeked like the health pong):

| `type` | Direction | Key fields |
|--------|-----------|-----------|
| `cache_get` | exec → dispatcher | `requestId; key; provider` |
| `cache_reply` | dispatcher → exec | `requestId; hit; ...value?` |
| `cache_put` | exec → dispatcher | `key; provider; ...value` |

Cache-aside semantics: the execution unit asks the dispatcher on a miss, fetches via its own provider capability, and writes the result back. The dispatcher stores each value as an opaque, TTL-stamped blob it never parses (see `agent-config-flow#8`).
