---
type: contract
title: App-Tool Bridge
related:
  - contracts/agent-routing
  - context/skills
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

Authoritative definition: the `REGISTRY` constant and `handleAppTool` in `src/main/agent/app-tool.ts`. Each entry flags `safe` (read = no confirmation). `handleAppTool` returns `{ ok:false, error: 'unknown app_tool op: <op>' }` for any unregistered `op`. `isSafeAppToolOp(op)` / `isKnownAppToolOp(op)` expose the flags. The model-facing tool names + descriptions live in `agent-server/app-tool-tools.ts` (`APP_SKILL_*_DESC`); read tools register with the provider's no-confirm flag (claude `tool()` / copilot `defineTool` with `skipPermission`), writes omit it so the user confirms.

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
| `web.open` | `{ url }` | `{ opened: true, url, message }` | no — gated **in main** per call, Open/Deny only (see below) | `browser_open` |

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

`web.fetch` rides the user's logged-in web session (cookies in main), so unlike the skill ops its authorization is **NOT** the provider tool-confirm. Both providers register `browser_fetch` as **skip-confirm** (claude `canUseTool` short-circuits `isWebFetchTool`, copilot `skipPermission:true`) — named `browser_fetch`, not `web_fetch`, because the Claude SDK ships a built-in `web_fetch` and a same-named external tool errors out (and ours is semantically different: `browser` = rides the user's logged-in browser session, vs the built-in `web` = anonymous public fetch) and the real gate runs inside `handleAppTool('web.fetch')`: parse the origin (`parseHttpOrigin`, anti-spoof), check the per-`(projectId, origin)` grant (`web-grants.ts`), and on a miss raise a dedicated app-global permission popup via `requestWebPermission` (`web-permission.ts` — its own `web:permission-request`/`-resolve` IPC, decoupled from the agent permission path). `allow always` persists the grant; `deny` → `{ ok:false }`. Because the tool always executes `handleAppTool`, this gates even under bypass permission mode, and is identical for Claude/Copilot. Returns the **raw** response — no expiry interpretation.

This op needs context the skill ops don't: `handleAppTool(op, args, ctx)` carries `ctx.projectId` (the grant key), threaded from `createRemoteBackend` → `spawnAgentServer` → `wrapProcess` → the `app_tool` handler.

### `web.open` — open a visible Web tab for the user to log in (`context/web-tab` web-tab#8)

Sibling of `web.fetch`: when `browser_fetch` hits a login wall, the agent calls `browser_open(url)` to open a **visible** Web tab navigated to `url` so the user can log in in-place (then retries `browser_fetch`). Cookies flow automatically via the shared `persist:web` partition — this op only opens the tab.

Like `web.fetch`, both providers register `browser_open` **skip-confirm** (claude `canUseTool` short-circuits `isBrowserOpenTool`, copilot `skipPermission:true`) and the real gate runs in main — but with a DIFFERENT, stricter prompt: `handleAppTool('web.open')` parses the origin (`parseHttpOrigin`, anti-spoof) then calls `requestBrowserOpen` (`src/main/browser-open.ts`), a per-call **Open/Deny** popup (`BrowserOpenPrompt.tsx`) with **no "remember" option and no persisted grant** — a single approval can never enable a later background open (the user's hard requirement). Own IPC (`web:browser-open-request`/`-resolve`/`-close`), decoupled from the agent path and from the `web:permission-*` grant path. Desktop-only, no Telegram/away routing (login needs the user at the keyboard); 5-min timeout → fail-closed deny. On `deny` → `{ ok:false, error: 'browser_open denied by user for <origin>' }` (fail-loud so the agent won't retry). On `open` → `openWebTab(ctx.projectId, url)` sends `web:open-tab`; `App.tsx` resolves the project and `addTab('web', url)` (auto-activated). Needs the same `ctx.projectId` as `web.fetch`.
