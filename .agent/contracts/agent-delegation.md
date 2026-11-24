---
type: contract
title: Worktree Agent Delegation
related:
  - contracts/app-tool-bridge
  - contracts/agent-routing
  - architecture/agent-execution
  - context/agent-core
---

# Worktree Agent Delegation

Authoritative constants and UI payloads: `src/shared/agent-delegation.ts` (`DELEGATION`).
Main owns memory-only relationships. A delegation id identifies a continuing collaboration,
not one turn or one result. View identity is `{ projectId,agentViewId }`; agentViewId is the
persisted View sessionId, not runtime tabId or transport nonce.

## MCP operations

Shared definitions: `agent-server/app-tool-tools.ts`, registered by SDK and HTTP adapters.
Main rejects unexpected arguments and checks transport-bound `AppToolContext.agentViewId`
and `agentTabId` against live sessions. Ids are not authorization; endpoint signing is unchanged.

| Tool | Main operation | Arguments | Result / authority |
|---|---|---|---|
| `shelf_select_agent` | `agent_delegation.select` | `{}` | Waits for desktop picker; `{cancelled:true}` or `{cancelled:false,target:{projectId,agentViewId,displayName,projectName}}`. Authorizes this caller/target pair. Five-minute timeout cancels. |
| `shelf_start_delegation` | `agent_delegation.start` | `{projectId,agentViewId,content}` | Consumes selection grant, revalidates worktree/live/available/non-self/unoccupied, locks recipient; `{delegationId,delivery}`. |
| `shelf_send_delegation` | `agent_delegation.send` | `{delegationId,content}` | Initiator-only; returns `DeliveryReceipt`. Intervention rejects rather than queues new work. |
| `shelf_delegation_status` | `agent_delegation.status` | `{delegationId?}` | Participant-only state list. Omitted id lists only caller relationships. No result text or progress transcript. |
| `shelf_report_progress` | `agent_delegation.progress` | `{delegationId,content}` | Recipient-only; replaces latest UI progress; `{updated:true}`. Does not create a main turn. |
| `shelf_submit_result` | `agent_delegation.result` | `{delegationId,content}` | Recipient-only; stores one non-empty text result; `{submitted:true}` without waiting for collection. Occupied slot rejects replacement. |

Candidates are open worktree Project Views. No general Project discovery, offline opening,
same-parent requirement or attachment transfer. Unavailable/occupied Views are disabled.
Tool envelopes retain `{ok,data?,error?}` and the shared bridge error formatting.

## Submission and manual collection

`DeliveryReceipt` is `{state:'received'|'failed'|'unknown',error?}`:

- `received`: an existing exec queue snapshot contained this factory msgId. Not model
  execution success, persistence or final experiment completion.
- `failed`: execution ended before writing the send frame; result slot remains retryable.
- `unknown`: write occurred without a receipt, or the ten-second receipt wait expired.
  Retain the result and prohibit automatic resend; a late receipt reconciles it.

Internal D1 sends use the common message Sender, mirror user history and use existing clientMsgId
correlation. Main filters those ids out of renderer optimistic projection. Execution drains
independently after tool receipt. The delegation adapter maps common success to `received`,
uncertain submission errors to `unknown`, and other errors to `failed`, preserving this MCP
contract. Late receipt callbacks still reconcile the result slot. Ordinary UI optimistic queue
behavior remains unchanged; submission Result details are in `contracts/agent-routing`.

UI collection occupies the result slot during transfer and clears only after main's queue
receives it. Duplicate collection rejects. Collection does not unlock/end the collaboration;
subsequent phases reuse the same id. No MCP tool reads result text; only manual collection
sends it into the main conversation. Results are text only.

## UI and lifecycle

`shelfApi.delegation` exposes `current`, `action`, `resolve`, `prepareClose`, `rename`,
`onUpdate`, `onPicker`, `onPickerClose`. Payload types and channel names are in the shared
module. Preload is RPC only; actions are `intervene`, `resume`, `extract`, `stop`.

Intervention opens the original input for the same task and is visible at both ends. It
does not stop execution. Ending intervention sends no message. Main also enforces recipient
input restrictions; independent stop/config/approval controls retain their semantics.
Progress/result submissions remain allowed. Main renders a list; recipient card sits
immediately above its input.

Stop deletes the relationship/unlocks without killing either Agent. Uncollected results
require discard confirmation. Explicit View closure ends affected relationships; reopening
does not restore them. Temporary disconnect, hibernation and provider replacement do not
themselves close a logical View. Project/worktree cleanup uses the same preflight before
teardown. No history, disk persistence or restart recovery: restart loses pending results.
Existing View and conversation persistence is unchanged.

Renderer teardown notices are separate from operation errors and scoped to the affected
participant tab IDs. Each View offers a keyboard-accessible Dismiss button. Dismissal
compares the displayed notice identity, so an older callback cannot remove a newer notice;
it leaves other Views, errors, active relationships and result slots unchanged. Snapshot
updates and tab switches do not recreate dismissed notices. Locally busy explicit actions
retain their existing suppression of teardown notices.
