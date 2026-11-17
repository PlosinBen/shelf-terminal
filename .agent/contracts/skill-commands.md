---
type: contract
title: Skill Commands
related:
  - context/skills
  - contracts/persistence-formats
---

# Skill commands

Types/validators: `src/shared/skill-commands.ts`. Source service: `createSkillCommandStore` in `src/main/skill-commands.ts`. The Skills editor reads and saves registration through IPC. The Agent menu displays session availability; main binds submissions and the execution queue revalidates before provider dispatch. Codex has an exact-path native adapter; Claude dispatches verified live plugin commands with images. Copilot app invocations remain explicitly unavailable because the required source and multipart dispatch guarantees are not established.

## Persistent metadata

A skill may contain `.shelf-command.json`:

```json
{
  "version": 1,
  "registrationId": "ad1b0c23-6789-4123-8123-123456789abc",
  "alias": "dev-flow",
  "description": "Run the development workflow"
}
```

Absence means unregistered. Unknown fields/versions, invalid UUIDs, invalid UTF-8/JSON and non-regular metadata files return errors. Alias and description are trimmed; alias is lowercase kebab-case, 1–64 ASCII characters without `/`; description is a nonempty single line, at most 256 JavaScript string code units. UUIDs are canonicalized to lowercase. Registration does not rewrite SKILL.md.

The factory requires `collectionDirectory` and the integration's authoritative `reservedAliases`. Its `read`, `catalog` and `save` return promises of `{ok:true,value}` or `{ok:false,error}`. Catalog errors must not become an empty catalog. Reads reject missing skills and source symlinks. Catalog includes disabled registrations and rejects duplicate aliases/registration IDs; it does not calculate session availability.

`save(name,{alias,description})` preserves the registration ID on edit and allocates a UUID for initial registration. Writes use exclusive same-directory temporary files with the `.shelf-command.json.tmp-` prefix followed by rename. Failure leaves prior metadata intact; cleanup failure is logged. `save(name,null)` unregisters, including recovery from malformed metadata files. It neither disables nor recreates a skill. User settings are unaffected by the agent lock. Whole-folder rename carries metadata; delete removes it.

## Mutation and portable payload

Skill CRUD, markers, aux mutations, command reads/writes, Backup capture and Import prepare/swap share `withSkillsMutation`. Remote Git work stays outside this boundary. Import validates staged replacements plus unselected live registrations as one final catalog before swapping any item. Selected skills may exchange aliases. Incoming absence removes destination registration; local lock/disabled markers retain their existing preservation rule. Whole-folder rollback includes metadata.

Authorization remains in the app-tool bridge. Content/aux mutations accept an optional caller guard, run after preceding mutations and before the write under the same source boundary. Agent create-finalization/update/write/delete recheck existence and lock state there. User calls preserve existing upsert and lock semantics. Guards must not call another serialized mutation API.

Root registration/temp paths, case variants and descendants are reserved from aux APIs and omitted from Files, local projection, remote enumeration and consumption hashes. Nested resource files with the same basename remain ordinary resources. Backup includes validated registration metadata but excludes staging files; metadata is portable payload, not a device-local marker.

Metadata-only Import refreshes the renderer without provider reload. Content changes retain full sync. The standalone command store itself does not notify or project; its IPC/editor adapter owns notification.

## Prefix and lookup

`parseShelfCommandPrefix` recognizes `/lowercase-kebab-alias` in single-line input with optional space/tab-separated arguments. Empty args are valid; multiline/native namespace syntax stays with existing dispatch. Canonical input and the existing native slash parser are unchanged.

`resolveSkillCommand(content,entries,nativeNames)` returns shared `none`, `native`, `match` or `error` kinds. Native names win collisions; unknown inputs return `none`; disabled/conflicting Shelf targets return errors. A match contains skill name, registration ID, alias and args. Callers must obtain a successful catalog before lookup, preserve the original message and establish execution-time validation separately. Lookup is not an execution receipt or proof of native loading.

## User editor IPC

`skills:editor-read` (`readEditor(name)`) returns `{ok,value:{content,command}}`; invalid metadata is an error inside `command`, leaving skill content readable. `skills:editor-save` (`saveEditor(request)`) accepts `{name,activeFile,content,commandDraft}`. All fields are required; unknown fields are rejected. `commandDraft` is a validated draft or explicit `null` to unregister. Fixed control aliases in `SKILL_COMMAND_RESERVED_ALIASES` are reserved. The Skills list additionally exposes optional `commandAlias`/`commandError` for display.

The user-only coordinator holds the shared mutation boundary, requires an existing regular skill/file, validates YAML, rename collisions and alias uniqueness before any writes, then saves content followed by command metadata. It reads back each step. Results include `ok`, actual `name`, `saved:{content,command}`, `contentChanged`, `commandChanged`, and optional `error`/`uncertain`. Rename can persist before content fails; the returned name reflects the observed directory. Unknown persisted state is `uncertain`, never successful. This is not a multi-file crash-atomic transaction. The unlocked editor/store operations are only for callers already holding `withSkillsMutation`; they must never be used as standalone mutation entry points.

Content changes, including observed partial success, run full skills sync; metadata-only changes notify the renderer. Uncertain mutation attempts conservatively notify affected consumers. Invalid drafts produce no writes. The editor advances confirmed baselines, retains unfinished drafts, blocks Back/file switches on failure, and requires reopen/readback after an uncertain acknowledgement. Lock does not restrict user Save. Canceling registration does not disable the skill.

## Menu and submission

`agent.skillCommands(tabId)` invokes `agent:skill-commands` and returns `{entries,error?}`. Each entry contains alias `name`, description, skill name, selection `{registrationId,catalogRevision}`, availability (`ready`, `pending`, `disabled`, `conflict`, `unavailable`), and optional reason. Catalog errors are shown explicitly. Backend `appSkillCommands.available` is required for ready; the renderer does not infer provider support. Native controls retain precedence, while a conflicting app entry remains visible with its reason.

The renderer stores the selected hint separately from canonical `AgentInputMessage`; argument edits preserve it, alias edits clear it, and catalog refresh does not silently replace it. All senders share main submission resolution. The renderer envelope accepts only tab id, canonical input/config edit, and optional selection; renderer-supplied invocation/path fields are rejected. A stale selected entry fails instead of becoming an ordinary prompt. Unknown manually typed slash and multiline input retain existing semantics. Pre-queue command rejection preserves the renderer's canonical input in history and returns its concrete reason.

Main binds `{kind:"app-skill",bindingId,skillName,registrationId,alias,args,payloadDigest}` to the SessionInstance owner, message id, and later execution id. The per-skill digest hashes sorted relative names plus bytes, including aux files and excluding source controls. Read errors, special files, symlinks and detected concurrent reads fail closed. Managed content/identity/mount mutations and Import replacements increment a per-skill revision; source directory identity also detects whole-folder replacement. Pure alias/description edits preserve existing bindings and never retarget queued work. External writers have no cross-process locking guarantee.

Bindings are released on terminal execution/cancellation, owner close, teardown and explicit reinitialization. Submission-confirmation timeout does not revoke a possibly delivered binding. Bindings are not durable across main restart.

## Execution control and native dispatch

After dequeue, exec sends `skill_invocation_validate` with request id, execution id, canonical message id and invocation. Main checks the exact live process/initialization epoch, owner, binding fields, current registration/enabled state, managed revision, directory identity and payload digest. It returns `skill_invocation_validate_result` with the same request/execution/message/binding ids and either `{ok:true}` or `{ok:false,code,error}`. These controls bypass the send queue and model tool bridge; dispatcher relay preserves sid. Timeout is ten seconds, with no retry; unmatched/malformed/late replies log context and cannot authorize another execution. Stop cancels pending validation and invalidates queue-selection stamps so stopped work cannot start afterward. Failure emits execution error then terminal idle and lets the queue continue.

Validation is the authorization point; subsequent mutations do not cancel an already authorized native turn. Codex force-reloads `skills/list`, requires an enabled exact canonical app path, rechecks the target-host projection digest, and sends text plus native `{type:"skill",name,path}` while retaining images. The invocation name comes from that exact native catalog match: either the leaf name or `shelf-skills:<name>` when Codex discovers the projection as a plugin; both text and skill item use the same native name. Skill arguments do not acquire reply-format guidance. There is no instruction-body fallback. Claude reloads the actual live query before dispatch, requires one plugin namespace at the canonical app root, validates the manifest and command index, rejects project commands that shadow the qualified namespace, and rechecks the projection digest. It sends the native namespaced command with original args and images; a stop/reconnect/dispose epoch prevents dispatch after cancellation. Copilot remains explicitly unavailable: pinned ACP multipart image prompts do not expand native skills, and name-only resolution cannot guarantee the app source. Fake-provider support verifies Shelf wire paths only.
