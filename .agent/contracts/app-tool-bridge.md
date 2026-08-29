---
type: contract
title: App-Tool Bridge
related:
  - contracts/agent-routing
  - context/skills
  - context/worktree
---

# App-Tool Bridge

The in-process RPC channel by which an agent (running in `agent-server`, possibly remote) acts on client-owned resources that live in **main** — currently app-level Agent Skills under `<userData>/skills/`. A per-provider bridge tool calls `callMain(op, args)`, which emits an `app_tool` request over the stdio wire; main dispatches it through an `op = resource.verb` registry against `skills-store`, and replies with `app_tool_result` matched by `requestId`. Reads are `safe` (no confirm); writes are permission-gated at the provider's tool registration, and `app_skill.update` is additionally lock/upsert-guarded in main.

## Wire messages

Two single-line JSON frames, correlated by `requestId` (modelled on the permission/picker round-trip). Authoritative shapes: `WireToHost`'s `app_tool` variant in `agent-server/providers/types.ts`; `IncomingMessage`'s `app_tool_result` in `agent-server/index.ts`; the matching emit/reply in `src/main/agent/remote.ts` (remote) and the local path's stdin/stdout.

**Request (agent-server → main):**

```jsonc
{ "type": "app_tool", "requestId": "at-1", "op": "app_skill.get", "args": { "name": "deploy-helper" } }
```

- `requestId` — `at-<seq>`, minted per call by `callMain` in `agent-server/app-tool-client.ts`. The pending promise is keyed on it.
- `op` — a registry key (`resource.verb`); see below.
- `args` — `Record<string, unknown>`; op-specific (may be `{}`).

**Result (main → agent-server):**

```jsonc
{ "type": "app_tool_result", "requestId": "at-1", "ok": true, "data": { "name": "deploy-helper", "content": "---\nname: ...\n---\n..." } }
```

- Shape = `AppToolResult` (`{ ok; data?; error? }`), defined identically in `src/main/agent/app-tool.ts` and `agent-server/app-tool-client.ts`.
- `ok: true` → `data` carries the op's JSON-serializable return. `ok: false` → `error` is a human-readable string surfaced to the model (e.g. `skill not found: x`).
- `resolveAppToolResult(requestId, result)` resolves the awaiting bridge tool. A missing channel or main-side failure always comes back as `{ ok: false, error }` — the bridge **never rejects/throws**.

The bridge tool formats the result for the model via `runBridgeTool` (`agent-server/app-tool-tools.ts`): on `ok`, the `data` (stringified if not already a string); on failure, `Error: <error>` flagged `isError`.

## Registry (op → args → return → safe?)

Authoritative definition: the `REGISTRY` constant and `handleAppTool` in `src/main/agent/app-tool.ts`. Each entry flags `safe` (read = no confirmation). `handleAppTool` returns `{ ok:false, error: 'unknown app_tool op: <op>' }` for any unregistered `op`. `isSafeAppToolOp(op)` / `isKnownAppToolOp(op)` expose the flags. The model-facing tool names + descriptions live in `agent-server/app-tool-tools.ts` (`APP_SKILL_*_DESC`). Claude registers tools through its SDK; Copilot and Codex consume the L1 in-process HTTP MCP bridge, injected respectively through ACP session config and app-server thread config. Provider-native approval behavior may differ, but the authoritative safe/write and app-level gates remain in main.

| op | args | return (`data`) | safe? | tool name |
|----|------|-----------------|-------|-----------|
| `app_skill.list` | — | `{ skills: SkillMeta[] }` (each `{ name, description? }`, includes `locked`) | **yes** (read) | `list_app_skills` |
| `app_skill.get` | `{ name: string }` | `{ name, content, files }` (`content` = full raw SKILL.md; `files` = aux-file paths) | **yes** (read) | `get_app_skill` |
| `app_skill.read_file` | `{ name, path }` | `{ name, path, content }` (one aux file, utf-8) | **yes** (read) | `read_app_skill_file` |
| `app_skill.create` | `{ content: string }` (full SKILL.md) | `{ name }` (final folder name) | no (write — confirm) | `create_app_skill` |
| `app_skill.update` | `{ name: string, content: string }` | `{ name }` (may differ if frontmatter renames) | no (write — confirm) | `update_app_skill` |
| `app_skill.write_file` | `{ name, path, content }` | `{ name, path }` | no (write — confirm) | `write_app_skill_file` |
| `app_skill.delete_file` | `{ name, path }` | `{ name, path }` | no (write — confirm) | `delete_app_skill_file` |
| `web.fetch` | `{ url, method?, headers?, body? }` | `{ status, headers, body }` (raw response) | no — gated **in main** per origin (not the provider confirm; see below) | `browser_fetch` |
| `web.open` | `{ url, reason? }` | `{ opened: true, url, message }` | no — gated **in main** per call, Open/Deny only (see below) | `browser_open` |
| `worktree.propose_create` | `{ branch?, note?, notes? }` | `{ opened: true, branch?, notePaths: string[], message }` | no — opens UI only; errors from a worktree child | `propose_worktree_create` |
| `worktree.propose_finish` | — | `{ opened: true, message }` | no — opens UI only; errors outside a worktree | `propose_worktree_finish` |

**Errors (`ok:false`):** missing/blank `name` / `content` / `path` → arg error; `app_skill.get` / `*_file` on absent skill → `skill not found: <name>`; `read_file` on a reserved/invalid path → `invalid or reserved skill file path: <path>`, on an absent file → `file not found: <path>`. See guards below for `update` / `*_file`. `delete` (whole-skill) is **deliberately not registered** — agents cannot delete skills (UI-only, same stance as unlock).

### Multi-file skills — the aux-file ops (`*_file`)

A skill folder can bundle aux files (scripts, reference docs) alongside SKILL.md. SKILL.md stays **privileged** — `update_app_skill` owns it (identity / rename / YAML validation / lock). The `*_file` ops handle every OTHER file as opaque utf-8, so an agent can author and maintain a script-bearing skill. (Projection + SDK loading were always folder-aware; this just opens the authoring path. Binary files are out — the bridge is a string model.)

The store gate is `resolveAuxPath(name, rel)` (`src/main/skills-store.ts`): resolves a folder-relative path within `skillDir`, returning null for anything blank, absolute, backslash/drive-letter, `..`-escaping, or **reserved** (`SKILL.md` / `.locked`). The "resolved path still inside skillDir" check is authoritative. Reserving SKILL.md + barring whole-skill delete is why **no bridge path can orphan a skill's SKILL.md**.

`*_file` write/delete guards in main (`src/main/agent/app-tool.ts`), in order: skill must exist (`getSkill !== null` — aux files cannot bootstrap a skill); not locked (`isSkillLocked` — lock covers the whole skill, enforced in main so it holds under bypass mode); then the store op (which re-asserts `resolveAuxPath`). On success → `onSkillsChanged()` (re-project + hot-reload). Writing an aux file not yet referenced by SKILL.md (or vice-versa) is a benign intermediate state, **not** an error.

### Write-path details (`src/main/agent/app-tool.ts`)

- **`app_skill.create`** — materialises a placeholder via `createSkill()`, then `updateSkill(placeholder, content)` writes the real body; the frontmatter `name` becomes identity (folder renamed; collision → error). On failure the placeholder is **rolled back** (`deleteSkillSafe`) so a failed create leaves nothing. On success calls `onSkillsChanged()` (re-project + hot-reload + renderer notify; see `context/skills` skills#2C).

- **`app_skill.update` guards** — `updateSkill` is an **upsert** at the store level (the create flow depends on it), so the bridge enforces the overwrite-existing-only contract here, not in the store:
  1. **Existence guard** — `getSkill(name) === null` → `skill not found: <name> (use create_app_skill...)`. Without this, updating a typo'd name would silently *create* a skill (context/skills skills#5).
  2. **Lock guard** — `isSkillLocked(name)` → error. The lock is a `.locked` marker the user sets in the Skills panel; it is enforced in **main** so it holds even under bypass/allow-all permission mode (where the write confirm is pre-granted). Agents have no unlock tool.

  Only after both guards does it call `updateSkill` and, on `ok`, `onSkillsChanged()`.

### `web.fetch` — gated in main, not at the provider (`context/web-tab`)

`web.fetch` rides the user's logged-in web session (cookies in main), so unlike the skill ops its authorization is **NOT** the provider tool-confirm. Claude registers `browser_fetch` as skip-confirm; Copilot ACP and Codex app-server receive it through the Shelf MCP bridge. Provider-native MCP approval may still occur, but the real gate runs inside `handleAppTool('web.fetch')`: parse the origin (`parseHttpOrigin`, anti-spoof), check the per-`(projectId, origin)` grant (`web-grants.ts`), and on a miss raise a dedicated app-global permission popup via `requestWebPermission` (`web-permission.ts`). `allow always` persists the grant; `deny` → `{ ok:false }`. Because the tool always executes `handleAppTool`, this gate holds under every provider permission mode. Named `browser_fetch`, not `web_fetch`, because the Claude SDK ships a conflicting built-in `web_fetch`. Returns the raw response.

Both web ops need context the skill ops don't: `handleAppTool(op, args, ctx)` carries required `ctx.projectId`, threaded from `createRemoteBackend` → `spawnAgentServer` → `wrapProcess` → the `app_tool` handler. `web.fetch` includes it in `WebPermissionMeta`; `web.open` includes it in `BrowserOpenMeta`. Missing context fails with `{ ok:false }` before a request or tab is opened.

### `web.open` — open a visible Web tab for the user to log in (`context/web-tab` web-tab#8)

Sibling of `web.fetch`: when `browser_fetch` hits a login wall, the agent calls `browser_open(url)` to open a **visible** Web tab navigated to `url` so the user can log in in-place (then retries `browser_fetch`). Cookies flow automatically via the shared `persist:web` partition — this op only opens the tab.

Like `web.fetch`, `browser_open` is skip-confirm on Claude and reaches Copilot ACP / Codex app-server through the Shelf MCP bridge. The real gate runs in main with a stricter per-call **Open/Deny** popup and no persisted grant. The optional reason is capped and non-authoritative; timeout fails closed. The gate carries the source project id so renderer can focus and identify its owner. On approval main opens that project's Web tab, and on denial returns a fail-loud error so the agent does not retry.

### `worktree.propose_*` — agent drafts, user commits (`context/worktree` worktree#1)

`propose_worktree_create({ branch?, note?, notes? })` sends `{ projectId, branch?, notePaths }` to open the New Worktree dialog. Before note resolution or renderer IPC, main resolves `ctx.projectId`; an unknown id returns `project not found: <id>`, and a project with `parentProjectId` returns `Cannot create a worktree project from a worktree project. Continue in the current child project and use propose_worktree_finish when the work is ready.` without opening the dialog. `note` is the legacy single-note alias; `notes` is the preferred multi-note list. Main trims inputs and, when note identifiers are present, lists the caller project's configured feature-note directory before opening the dialog. Each identifier resolves by exact canonical repo-relative path first, then by unique basename; canonical paths are deduplicated in first-seen order. A disabled binding, listing failure, unknown identifier, or ambiguous basename returns `{ ok:false }` without opening a misleading prefill. With no note identifiers, the proposal may open without listing even when the binding is disabled; the renderer omits the Feature Note section.

`propose_worktree_finish()` sends `{ projectId }` to open the Finish gate. Both proposal tools return an acknowledgement only: the user must click Create or Finish before any git action occurs. `propose_worktree_finish` first resolves `ctx.projectId` against the cached project list and returns `{ ok:false }` without IPC when it is not a worktree (`parentProjectId` absent).

The model-facing descriptions state only observable capability, dialog inputs, confirmed runtime effects, and project-kind rejection. They do not decide when feature notes are created or maintained, when development is ready, or how the cross-session development workflow proceeds; those semantics belong to the development and integration skills (`context/worktree` worktree#15).

For these two worktree proposal ops only, main also injects an Agent View audit card. The event is a renderer primitive (`fold_code`), not a provider-native tool card: `label: "Shelf tool"`, `subtitle` = the model-facing MCP tool name (`propose_worktree_create` / `propose_worktree_finish`), and `msgId: "app-tool-<requestId>"`. The first body is `{ args }`; after `handleAppTool` returns, main upserts the same `msgId` with `{ args, result }`. For create, `result.notePaths` shows the canonical paths actually sent to the dialog. Non-worktree app-tools are intentionally not audited here to avoid noisy timelines and accidental exposure of sensitive/large app-tool arguments.
