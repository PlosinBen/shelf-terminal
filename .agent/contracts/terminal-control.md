---
type: contract
title: Terminal Control Protocol
related:
  - architecture/terminal-io
  - contracts/connector-interface
  - contracts/ipc-channels
  - context/terminal-pty
---

# Terminal Control Protocol

This contract covers the immutable terminal launch boundary, target-facts response, PTY initialization frames, and renderer presentation phases. Authoritative definitions live in `src/main/connector/launch-plan.ts`, `src/main/connector/target-facts.ts`, `src/shared/shelf-osc.ts`, `src/shared/terminal-init-osc.ts`, and `src/shared/types.ts`.

## Terminal launch plan

Connector composition materializes one immutable plan; the runner selects either a compatibility request or an explicit interpreter request.

```ts
interface TerminalLaunchPlan {
  kind: 'compatibility' | 'interpreter';
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  logContext: string;
}
```

`compatibility` preserves the connector's previous terminal behavior when target-facts resolution fails. `interpreter` freezes the resolved target shell path and allows runner-required environment plus explicit environment preservation before launch.

## Target-facts exec frame

The terminal-owned resolver runs ordered POSIX and PowerShell candidates through the connector's bounded non-interactive command path. A successful candidate emits exactly one line:

```text
__SHELF_TARGET_FACTS_V1__:<nonce>:<base64url-json>
```

Decoded Unix payload:

```json
{"targetOS":"unix","defaultShell":"/bin/zsh"}
```

Decoded Windows payload:

```json
{"targetOS":"windows","defaultShell":"powershell.exe"}
```

The resolver requires one matching nonce-bound frame, bounded stdout and payload sizes, and the exact schema. Noise around the line is allowed. Missing, duplicate, malformed, oversized, stale-generation, or non-positive candidates produce one cached probe failure for the runtime generation; they do not infer the other operating system.

## Shelf OSC envelope

Shelf-owned PTY control messages share one bounded streaming router:

```text
ESC ] 6973 ; <route> ; <version> ; <payload> BEL
```

`ST` (`ESC \\`) is also accepted as the terminator. Unknown routes and versions remain ordinary visible PTY bytes. A handler consumes bytes only while it owns the corresponding lifecycle transition.

## `terminal-init` route

Version 1 uses a base64url-encoded JSON payload:

```json
{"nonce":"<session nonce>","phase":"runner","result":"ready"}
```

Allowed phase/result pairs:

| `phase` | Allowed `result` | Meaning |
|---|---|---|
| `runner` | `ready`, `isolation-unconfirmed` | Explicit runner reached its first controlled boundary; the latter keeps the shell usable without claiming project-history isolation. |
| `init-script` | `success`, `failure`, `cancelled` | The supported runner completed Shelf's internal project initScript. |

Main accepts only the current session nonce and expected phase. Malformed, oversized, nonce-mismatched, or unexpected-phase frames never advance the lifecycle. After the terminal is ready, matching-looking bytes return to the visible output path.

Zsh and Bash hooks first emit the runner result, then consume one nonce-bound main-to-shell directive:

```text
: __SHELF_INIT_DIRECTIVE__ <nonce> normal
```

The normal directive authorizes internal `initScript` execution without storing the directive or script as an interactive history entry. On the 10-second runner fallback, main writes the fallback directive and configured automatic commands atomically; a delayed hook consumes the directive and skips duplicate internal execution.

## Renderer presentation phase

Main publishes `PtyInitPhasePayload` over `pty:init-phase`:

```ts
interface PtyInitPhasePayload {
  tabId: string;
  phase: 'initializing' | 'init-script' | 'ready' | 'failed';
}
```

`initializing` is globally covered. `init-script` is visible but main accepts only Ctrl+C. `ready` allows normal input. The renderer stores and displays these phases; it does not interpret runner, connector, history, nonce, or OSC state.
