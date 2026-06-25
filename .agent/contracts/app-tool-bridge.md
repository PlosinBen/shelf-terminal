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
| `app_skill.get` | `{ name: string }` | `{ name, content }` (full raw SKILL.md) | **yes** (read) | `get_app_skill` |
| `app_skill.create` | `{ content: string }` (full SKILL.md) | `{ name }` (final folder name) | no (write — confirm) | `create_app_skill` |
| `app_skill.update` | `{ name: string, content: string }` | `{ name }` (may differ if frontmatter renames) | no (write — confirm) | `update_app_skill` |

**Errors (`ok:false`):** missing/blank `name` or `content` → arg error; `app_skill.get` on absent skill → `skill not found: <name>`. See guards below for `update`. `delete` is **deliberately not registered** — agents cannot delete skills (UI-only, same stance as unlock).

### Write-path details (`src/main/agent/app-tool.ts`)

- **`app_skill.create`** — materialises a placeholder via `createSkill()`, then `updateSkill(placeholder, content)` writes the real body; the frontmatter `name` becomes identity (folder renamed; collision → error). On failure the placeholder is **rolled back** (`deleteSkillSafe`) so a failed create leaves nothing. On success calls `onSkillsChanged()` (re-project + hot-reload + renderer notify; see `context/skills` skills#2C).

- **`app_skill.update` guards** — `updateSkill` is an **upsert** at the store level (the create flow depends on it), so the bridge enforces the overwrite-existing-only contract here, not in the store:
  1. **Existence guard** — `getSkill(name) === null` → `skill not found: <name> (use create_app_skill...)`. Without this, updating a typo'd name would silently *create* a skill (context/skills skills#5).
  2. **Lock guard** — `isSkillLocked(name)` → error. The lock is a `.locked` marker the user sets in the Skills panel; it is enforced in **main** so it holds even under bypass/allow-all permission mode (where the write confirm is pre-granted). Agents have no unlock tool.

  Only after both guards does it call `updateSkill` and, on `ok`, `onSkillsChanged()`.
