---
type: contract
title: Connector Interface
related:
  - context/connector
  - architecture/connection-lifecycle
  - contracts/terminal-control
---

# Connector Interface

Connector composition separates persisted connection data, connector protocol behavior, and the operating system running Shelf. Consumers receive a `ConnectorRuntime`; they never select a client executable or infer the target OS from the connection method.

Authoritative definitions live in `src/main/connector/config.ts`, `runtime.ts`, `launch-plan.ts`, `types.ts`, and `index.ts`. Connection-type shapes live in `src/shared/types.ts`.

## Factory

`createConnector(connection: Connection): ConnectorRuntime` — `src/main/connector/index.ts`. The runtime owner keys and reuses a live generation by immutable `ConnectorConfig`. AppOS registry membership is the structural support list; the selected adapter creates protocol behavior and materializes terminal launch plans for the OS running Shelf. Establishing an external link remains deferred to `connect()`.

Companion exports (same file):

| Export | Signature | Purpose |
|--------|-----------|---------|
| `getAvailableTypes` | `(): ConnectionType[]` | Connection types selectable on the current OS (`wsl` is Windows-only). |
| `listDockerContainers` | `(): Promise<string[]>` | Enumerate running Docker containers for the picker. |
| `listWSLDistros` | `(): Promise<string[]>` | Enumerate WSL distros (empty off Windows). |
| `invalidateConnectorRuntime` | `(connection): void` | Invalidates the matching runtime generation so later terminal facts cannot reuse stale completion. |
| `cleanupConnectors` | `(): void` | App-quit hook; invalidates all runtime generations and terminates SSH ControlMaster sockets. |

## Methods

Each runtime delegates ordinary target operations to a connector protocol implementation. `cwd` arguments are absolute paths in the target environment.

| Method | Signature | Purpose |
|--------|-----------|---------|
| `createCompatibilityLaunchPlan` | `(cwd, env?, requiredEnv?): TerminalLaunchPlan` | Materialize the connector's behavior-preserving terminal startup without target-shell classification. |
| `createInterpreterLaunchPlan` | `(cwd, interpreter, interpreterArgs, env?, requiredEnv?, preserveEnv?): TerminalLaunchPlan` | Materialize an explicit resolved target interpreter through the same AppOS/connector composition. |
| `spawnTerminalPlan` | `(plan): Shell` | Spawn an already materialized immutable plan; returns the connector-neutral `Shell` surface. |
| `createShell` | `(cwd, env?, requiredEnv?): Shell` | Compatibility wrapper for consumers that do not use runner selection. |
| `isConnected` | `(): Promise<boolean>` | Probe whether the link is currently reachable. |
| `connect` | `(password?: string): Promise<void>` | Establish/authenticate the link (e.g. SSH ControlMaster); `password` is used for SSH first-connect. |
| `exec` | `(cwd: string, cmd: string): Promise<ExecResult>` | Run a non-interactive command in the target env (e.g. git ops); returns `{ stdout, stderr }`. Not exposed as a generic IPC channel. |
| `listDir` | `(dirPath: string): Promise<FolderListResult>` | List directory entries for the folder picker. |
| `homePath` | `(): Promise<string>` | Resolve the target user's home directory. |
| `uploadFile` | `(cwd: string, filename: string, buffer: Buffer): Promise<string>` | Write `buffer` into `<cwd>/.tmp/shelf/<prefix>-<filename>` (layout from the `upload` placement in `@shared/shelf-paths`); returns the target-side path. Implemented ON TOP of `putFile` + a separate non-clobber `.tmp/.gitignore` guard — not its own write command (`architecture/transport`). |
| `putFile` | `(remotePath: string, buffer: Buffer): Promise<void>` | Write `buffer` to an ABSOLUTE target path (mkdir parents). The connector's ONE byte primitive: used by the type-declared transport (`transportPut`/`transportPutDir`) for control-plane files (MCP config, skills tree) AND by `uploadFile`. Not exposed over IPC. |
| `cleanupSession` | `(cwd: string, cutoffMs: number): Promise<number>` | Remove staged uploads older than `cutoffMs`; returns count removed. |
| `clearUploads` | `(cwd: string): Promise<number>` | Remove all staged uploads under `cwd`; returns count removed. |
| `getUploadsSize` | `(cwd: string): Promise<{ totalBytes: number; fileCount: number }>` | Size/count of `<cwd>/.tmp/shelf/` for Project Edit display; returns zeros on any failure (no error distinction). |

`Shell` exposes `onData(cb): Disposable`, `onExit(cb): Disposable`, `write(data)`, `resize(cols, rows)`, and `kill()`. `Disposable` is `{ dispose(): void }`. Terminal launch-plan and control-frame formats are specified in `contracts/terminal-control`.

## Connection types

Defined as the discriminated union `Connection` in `src/shared/types.ts`; `createConnector` dispatches on `type`.

| `type` | Config fields | Implementation |
|--------|---------------|----------------|
| `local` | _(none)_ — `LocalConnection` | `local/unix.ts` / `local/win32.ts` (by platform) |
| `ssh` | `host`, `port`, `user`, optional `password`, optional idle-shutdown minutes — `SSHConnection` | `ssh/unix.ts` / `ssh/win32.ts` (by platform) |
| `wsl` | `distro` — `WSLConnection` (Windows only) | `wsl.ts` |
| `docker` | `container` — `DockerConnection` | `docker.ts` |

See `src/shared/types.ts` for the full `SSHConnection` shape, including the SSH-only idle-shutdown boundary field (only SSH is not fate-shared with the client).
