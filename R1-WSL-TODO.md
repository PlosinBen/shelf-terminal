# R1 — WSL self-contained deploy: completion handoff

This is a **self-contained** handoff for finishing WSL support on a **Windows
host** (it can't be developed/validated on macOS/Linux). The scaffold is already
in the branch and **inert by default** — turning it on is a single env flag.

> Branch: `feat/r1-self-contained-agent-server`. This doc is committed so it
> reaches the Windows machine via git. (The richer design notes live in
> `.agent/features/rust-shell-target.md`, which is gitignored and will NOT sync —
> everything you need is reproduced here.)

---

## TL;DR

R1 makes the agent-server **self-contained on remotes**: instead of relying on
the remote's installed Node/CLI, we ship our own. It's done + tested for
**ssh** and **docker** (glibc ships our Node; musl uses the remote's Node + we
ship the Claude/Copilot binary). **WSL is the same idea** — a Linux distro
reached via `wsl.exe` — and is **scaffolded but not finished/validated**.

Turn it on with `SHELF_WSL_SELF_CONTAINED=1`, finish the 3 items below, then make
it the default and delete the legacy path.

---

## What to search for (orient yourself)

Open these symbols (ripgrep the repo):

- `SHELF_WSL_SELF_CONTAINED` → the env gate (in `deployAgentServer`).
- `wslOps` → the WSL `RemoteOps` impl to finish (`src/main/agent/remote.ts`).
- `deploySelfContained` → the shared deploy flow WSL reuses (same file).
- `sshOps`, `dockerOps` → the **working reference** RemoteOps impls to mirror.
- `RemoteOps` → the interface (`exec` / `copyIn` / `base`).
- `toWslPath` → Windows→WSL path translation helper.
- `TARGET_PROBE_CMD`, `detectTargetFromProbe`, `isRemoteNodeSupported` → reused
  as-is (`src/main/agent/runtime-target.ts`).

All deploy logic is in **`src/main/agent/remote.ts`**.

---

## How the model works (so the scaffold makes sense)

`deploySelfContained(connection, ops, providerBin)` is connection-agnostic. It:

1. **Probes** the target's arch+libc: `ops.exec(TARGET_PROBE_CMD)` →
   `detectTargetFromProbe()`.
2. Decides node strategy by libc:
   - **glibc** → ship our own Node (`ensureNodeCached`), run `<root>/node`.
   - **musl** → use the remote's own node (verify `node --version` ≥ 20 via
     `isRemoteNodeSupported`), run `node`. We never ship a musl Node.
3. **Ensures** the per-target binaries are cached locally (downloaded once):
   our Node (glibc only) + the provider binary (`ensureClaudeCached` /
   `ensureCopilotCached`).
4. **Incrementally deploys** `{node?, index.mjs, <provider-binary>}` to
   `~/.shelf/agent-server/<version>/` via `ops.copyIn`, writing a `.deployed`
   sentinel last (so a half-finished transfer is never mistaken for complete).
5. Returns `{ nodeBin, indexPath }` which `spawnAgentServer` runs.

A `RemoteOps` just teaches that flow how to talk to a given connection:

```ts
interface RemoteOps {
  base: string;                                  // home the deploy root hangs off
  exec(cmd: string, timeoutMs?): string;         // run a shell command, return stdout
  copyIn(localPath: string, remotePath: string, timeoutMs?): void;  // host → remote file copy
}
```

`sshOps` (uses `ssh`/`scp`) and `dockerOps` (uses `docker exec`/`docker cp`) are
the working examples. `wslOps` must do the same via `wsl.exe`.

---

## Current scaffold (already in the branch)

In `src/main/agent/remote.ts`:

- `wslOps(connection)` — a first-cut RemoteOps for WSL:
  - `exec`: `wsl.exe -d <distro> -- sh -c '<cmd>'`
  - `copyIn`: reads the Windows-side cached file via `/mnt` (`toWslPath`) and
    `cp`s it inside WSL.
  - `base: '~'`
- `deployAgentServer()` WSL branch:
  ```ts
  if (connection.type === 'wsl') {
    if (process.env.SHELF_WSL_SELF_CONTAINED) {
      return deploySelfContained(connection, wslOps(connection), providerBin); // NEW path
    }
    return { nodeBin: 'node', indexPath: toWslPath(getLocalBundlePath()) };     // legacy, default
  }
  ```

So today nothing changes for WSL users; the new path only runs with the flag.

---

## The 3 things to finish/verify on Windows

### 1. Shell quoting on the Windows host ⚠️ most likely to break
`ops.exec`/`copyIn` build a command string and run it with `execSync`. On a
**Windows host**, `execSync`'s default shell is **cmd.exe**, where the
**single-quote wrapping** used by `wslOps` (copied from the POSIX ssh/docker
impls) does **not** work.

- **Verify:** does `wsl.exe -d <distro> -- sh -c '...'` actually run from cmd.exe
  with the current quoting?
- **Likely fix:** pass args as an array via `spawnSync`/`execFileSync`
  (`execFileSync('wsl.exe', ['-d', distro, '--', 'sh', '-c', cmd])`) instead of a
  single `execSync` string — avoids host-shell quoting entirely. Consider
  switching `RemoteOps.exec/copyIn` to the array form for the WSL impl.
- Search: `execSync` in `remote.ts`; compare with how `spawnAgentServer` already
  uses `spawn('wsl.exe', ['-d', connection.distro, '--', 'sh', '-lc', ...])`
  (array form — mirror that).

### 2. `~` expansion under `wsl.exe -d <distro> -- sh -c`
`deploySelfContained` uses `base: '~'` and relies on the remote shell expanding
`~` (ssh/docker do). Confirm `~` expands inside `wsl.exe -d <distro> -- sh -c
'echo ~'`. If not, set `base` to an absolute home (e.g. derive `$HOME` via an
`exec`), similar to how docker uses `/root`.

### 3. `/mnt` copyIn correctness + speed
`copyIn` copies the cached binary from the Windows filesystem into WSL by reading
it through `/mnt/c/...` (`toWslPath`).

- **Verify:** the `cp` actually lands the file in the WSL deploy root.
- **Perf:** the Claude binary is ~215 MB and `/mnt` (the Windows↔WSL bridge) can
  be slow. Time it. If too slow, alternatives: copy into WSL's native fs first,
  or write via `wsl.exe` stdin, or `\\wsl$\` path from the Windows side.

---

## How to test it (mirror the docker E2E)

There's a working docker-based E2E you can copy:

- `e2e/connector/agent-deploy.spec.ts` (glibc), `agent-deploy-musl.spec.ts`,
  `agent-deploy-copilot.spec.ts`
- `e2e/connector/agent-deploy-helpers.ts` (`makeShelfAppFixture`,
  `assertPickerRoundTrip`, `containerHasNode`, `deployedFiles`)
- `package.json` → `test:agent-deploy` (starts containers, runs the project)
- `playwright.config.ts` → the `agent-deploy` project (`testMatch:
  'agent-deploy*.spec.ts'`)

For WSL, add `agent-deploy-wsl.spec.ts` that:
1. Seeds a project with a `{ type: 'wsl', distro: '<your-distro>' }` connection.
2. Launches the app with `SHELF_TEST_MODE=1`, `SHELF_RUNTIME_CACHE_DIR=<persistent>`,
   **and `SHELF_WSL_SELF_CONTAINED=1`**.
3. Opens a Claude agent and asserts the picker round-trip
   (`assertPickerRoundTrip`) — proves deploy + spawn worked over WSL.
4. (glibc distro) asserts `deployedFiles` includes `node` + `index.mjs` +
   `claude`; (Alpine/musl distro) asserts NO `node` shipped.

`makeShelfAppFixture` currently hard-codes a docker connection — generalize it to
accept a connection object, or write a small WSL-specific fixture.

> Note: `SHELF_TEST_MODE=1` runs the **fake provider**, so the round-trip
> validates deploy + our-Node spawn without needing Claude/Copilot auth — same as
> the docker E2E.

### Running it (differs from docker — no container to start)

The docker E2E's `test:agent-deploy` script does `docker run` to create the
target container. **WSL has no such step** — you use a WSL distro **already
installed** on the Windows machine.

1. List your distros and pick one: `wsl -l -v`. Put its exact name in the spec's
   `{ type: 'wsl', distro: '<name>' }`.
   - glibc distro (Ubuntu/Debian) exercises the "ship our Node" path.
   - an Alpine WSL distro (musl) exercises the "use remote node" path — optional.
   - For a clean "no node" assertion, use a distro where node isn't installed
     (or `which node` is empty); for the musl path you DO want node present.
2. Add a dedicated npm script — **build only, no `docker run`** — e.g.:
   ```jsonc
   "test:agent-deploy-wsl": "set SHELF_WSL_SELF_CONTAINED=1 && NODE_ENV=test npm run build && NODE_ENV=test npx playwright test --project=agent-deploy agent-deploy-wsl.spec.ts"
   ```
   (Windows shell syntax; adjust env-var setting for your shell. Or set
   `SHELF_WSL_SELF_CONTAINED` inside the spec's fixture `env` instead — cleaner
   and shell-independent, matching how the fixture already sets `SHELF_TEST_MODE`.)
3. First run downloads the per-target Node/Claude into `SHELF_RUNTIME_CACHE_DIR`
   (persistent) → reused after. Deploy lands in the distro's
   `~/.shelf/agent-server/<version>/`; you can inspect via
   `wsl -d <name> -- ls ~/.shelf/agent-server/*/`.

> Recommended: set `SHELF_WSL_SELF_CONTAINED` (and the other flags) in the test
> fixture's `env`, so the test is self-driving and you don't depend on a shell
> script — then you can just run `npx playwright test --project=agent-deploy`.

---

## Definition of done

- [ ] `wslOps` works on a Windows host (quoting/`~`/`/mnt` all handled).
- [ ] An `agent-deploy-wsl` E2E passes (glibc distro at minimum; musl too if you
      have an Alpine WSL).
- [ ] Make the self-contained path the **default** for WSL and **delete** the
      legacy branch + the `SHELF_WSL_SELF_CONTAINED` gate in `deployAgentServer`.
- [ ] Update `wslOps` header comment (remove the "UNVERIFIED" warning).
- [ ] Update `.agent/GOTCHAS.md` #344 (WSL no longer relies on remote Node for
      glibc; musl uses remote node like the ssh/docker musl path).
- [ ] Delete this `R1-WSL-TODO.md`.

---

## Key files

| File | What |
|------|------|
| `src/main/agent/remote.ts` | `wslOps`, `deployAgentServer` (the flag), `deploySelfContained`, `sshOps`/`dockerOps` (references), `spawnAgentServer` |
| `src/main/agent/runtime-target.ts` | arch/libc probe + parse, `isRemoteNodeSupported` |
| `src/main/agent/runtime-cache.ts` | `ensureNodeCached` / `ensureClaudeCached` / `ensureCopilotCached` |
| `src/main/agent/deploy-layout.ts` | `deployRoot`, `deployFilesFor`, `needsDeploy`, paths |
| `e2e/connector/agent-deploy*.spec.ts` + `agent-deploy-helpers.ts` | E2E to mirror |
| `package.json` / `playwright.config.ts` | `test:agent-deploy` script + project |
