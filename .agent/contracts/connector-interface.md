---
type: contract
title: Connector Interface
related:
  - context/connector
  - architecture/connection-lifecycle
---

# Connector Interface

The `Connector` is the single abstraction that hides where work runs — same machine, a remote host over SSH, a Windows Linux subsystem, or a container — behind one uniform method surface; every consumer (pty-manager, file-transfer, git/IPC handlers) talks to a `Connector` and never branches on connection type.

Authoritative definitions live in `src/main/connector/types.ts` (`Connector`, `Shell`, `Disposable`, `ExecResult`) and `src/main/connector/index.ts` (`createConnector`). Connection-type shapes live in `src/shared/types.ts`.

## Factory

`createConnector(connection: Connection): Connector` — `src/main/connector/index.ts`. Synchronously dispatches on `connection.type` (and `process.platform` for local/SSH) and returns the matching implementation. There is no async setup here; establishing the actual link is deferred to `connect()`.

Companion exports (same file):

| Export | Signature | Purpose |
|--------|-----------|---------|
| `getAvailableTypes` | `(): ConnectionType[]` | Connection types selectable on the current OS (`wsl` is Windows-only). |
| `listDockerContainers` | `(): Promise<string[]>` | Enumerate running Docker containers for the picker. |
| `listWSLDistros` | `(): Promise<string[]>` | Enumerate WSL distros (empty off Windows). |
| `cleanupConnectors` | `(): void` | App-quit hook; terminates SSH ControlMaster sockets. |

## Methods

Every connector implements the `Connector` interface (`src/main/connector/types.ts`). `cwd` arguments are absolute paths in the target environment.

| Method | Signature | Purpose |
|--------|-----------|---------|
| `createShell` | `(cwd: string): Shell` | Spawn an interactive PTY shell rooted at `cwd`; returns a `Shell` (consumers never import node-pty). |
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

`Shell` (returned by `createShell`) exposes `onData(cb): Disposable`, `onExit(cb): Disposable`, `write(data)`, `resize(cols, rows)`, and `kill()`. `Disposable` is `{ dispose(): void }`.

## Connection types

Defined as the discriminated union `Connection` in `src/shared/types.ts`; `createConnector` dispatches on `type`.

| `type` | Config fields | Implementation |
|--------|---------------|----------------|
| `local` | _(none)_ — `LocalConnection` | `local/unix.ts` / `local/win32.ts` (by platform) |
| `ssh` | `host`, `port`, `user`, optional `password`, optional idle-shutdown minutes — `SSHConnection` | `ssh/unix.ts` / `ssh/win32.ts` (by platform) |
| `wsl` | `distro` — `WSLConnection` (Windows only) | `wsl.ts` |
| `docker` | `container` — `DockerConnection` | `docker.ts` |

See `src/shared/types.ts` for the full `SSHConnection` shape, including the SSH-only idle-shutdown boundary field (only SSH is not fate-shared with the client).
