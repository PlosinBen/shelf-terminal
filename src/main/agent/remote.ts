import { log } from '@shared/logger';
import type { Connection, AgentProvider, AgentInitPhase, ProviderModel, TaskEvent } from '@shared/types';
import type { AgentBackend, AgentEvent, AgentQueryOptions, PickerResolvePayload } from './types';
import { ChildProcess, spawn, execSync, execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getShellEnv } from '../connector/shell-env';
import { createTurnDispatcher, type PermissionHandler } from './turn-dispatcher';
import {
  detectTargetFromProbe,
  targetId,
  isRemoteNodeSupported,
  MIN_REMOTE_NODE_MAJOR,
  TARGET_PROBE_CMD,
} from './runtime-target';
import { CLAUDE_SDK_VERSION, COPILOT_CLI_VERSION } from './agent-runtime-versions';
import { ensureNodeCached, ensureClaudeCached, ensureCopilotCached } from './runtime-cache';
import {
  deployRoot,
  agentServerDir,
  deployFilesFor,
  needsDeploy,
  missingFiles,
  DEPLOY_FILES,
  DEPLOYED_SENTINEL,
  type DeployFile,
  type ProviderBin,
  type RemoteInventory,
} from './deploy-layout';

/**
 * How to launch agent-server on a target. `nodeBin` is `'node'` (local/wsl —
 * use the target's own node) or an absolute `<root>/node` (ssh/docker — the
 * Node runtime we shipped). `indexPath` is the agent-server bundle on the target.
 */
interface DeployResult {
  nodeBin: string;
  indexPath: string;
}

interface RemoteProcess {
  sendLine: (msg: object) => void;
  /**
   * Register a turn so agent-server events tagged with `turnId` get routed to
   * the returned AsyncGenerator. MUST be called before `sendLine({type:'send',turnId,...})`
   * so the dispatcher knows where to deliver events that may arrive before
   * the registration completes. Generator ends on first `state:'idle'` event.
   */
  registerTurn: (turnId: string, permissionHandler: PermissionHandler) => AsyncGenerator<AgentEvent>;
  /** Wait for agent-server's `{type:'ready'}` signal. Resolves false on timeout. */
  awaitReady: (timeoutMs?: number) => Promise<boolean>;
  onResponse: (requestId: string, expectedType: string, handler: (payload: any) => void) => void;
  kill: () => void;
}

export function createRemoteBackend(
  connection: Connection,
  initScript?: string,
  provider: AgentProvider = 'claude',
  sessionId?: string,
  // Optional per-tab init-phase reporter — main wires it to AGENT_INIT_STATUS
  // so the renderer's spinner text refines as deploy/spawn/probe progress.
  // Defaults to no-op, keeping the backend connection-agnostic.
  onPhase?: (phase: AgentInitPhase) => void,
  // Optional per-tab background-task sink — main wires it to
  // AGENT_BACKGROUND_TASKS. Session-level (NOT per-turn): a backgrounded task
  // outlives the turn that spawned it. See background-tasks.md.
  onTaskEvent?: (ev: TaskEvent) => void,
  // Optional sink for a server-initiated turn (auto-resume prose after a
  // background task finishes). Receives the turnId + the turn's event
  // generator to drain into the renderer. See background-tasks.md M3.
  onServerTurn?: (turnId: string, events: AsyncGenerator<AgentEvent>) => void,
): AgentBackend {
  let remoteProc: RemoteProcess | null = null;
  let deployed = false;
  let deployResult: DeployResult | null = null;
  // Single in-flight init shared by concurrent callers. getCapabilities (on tab
  // open) and query (on first send) fire almost together, so without this BOTH
  // would pass the `!deployed` check and run deploySelfContained concurrently —
  // the two deploys then collide copying the same files (one deploy's spawned
  // `<root>/node` is already executing while the other `cp`s over it → ETXTBSY
  // "Text file busy", failing one turn nondeterministically). Reset on failure
  // so a later call can retry (e.g. after the user authenticates on the remote).
  let initInFlight: Promise<RemoteProcess | null> | null = null;

  function ensureProcReady(cwd: string): Promise<RemoteProcess | null> {
    if (remoteProc) return Promise.resolve(remoteProc);
    if (!initInFlight) {
      initInFlight = (async () => {
        if (!deployed) {
          onPhase?.('deploying');
          deployResult = await deployAgentServer(connection, provider);
          deployed = true;
        }
        onPhase?.('connecting');
        const proc = await spawnAgentServer(connection, cwd, deployResult!, initScript, onTaskEvent, onServerTurn);
        if (!proc) return null;
        const ready = await proc.awaitReady();
        if (!ready) {
          proc.kill();
          return null;
        }
        remoteProc = proc;
        return proc;
      })().catch((err: any) => {
        log.error('agent-remote', `Init failed: ${err.message}`);
        return null;
      });
    }
    return initInFlight.then((proc) => {
      if (!proc) initInFlight = null; // failed → allow a fresh attempt next call
      return proc;
    });
  }

  const backend: AgentBackend = {
    async checkAuth(cwd: string) {
      // Reuse the capabilities probe and invert its verdict. Claude's
      // ensureInit re-runs here because a failed probe isn't cached, so after
      // the user runs `claude login` on the remote this flips to true and the
      // AuthPane clears. Any spawn/RPC failure → false (stay on AuthPane).
      try {
        const caps = await backend.getCapabilities!(cwd);
        return !caps.authRequired;
      } catch {
        return false;
      }
    },

    async *query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent> {
      const proc = await ensureProcReady(cwd);
      if (!proc) {
        yield { type: 'error', error: 'Failed to start agent-server' };
        return;
      }

      // Main-side generates the turnId so we can register the per-turn
      // dispatcher BEFORE sending. Agent-server respects the incoming
      // turnId and tags every outgoing event with it.
      const turnId = `t-${randomUUID().slice(0, 8)}`;

      const userCallback = opts?.canUseTool;
      const permissionHandler: PermissionHandler = (toolUseId, toolName, input) => {
        // Fire-and-forget — resolve_permission round-trips back to the
        // dispatcher which delivers the canUseTool answer asynchronously.
        (async () => {
          if (!userCallback) {
            proc.sendLine({ type: 'resolve_permission', toolUseId, allow: true });
            return;
          }
          const result = await userCallback(toolUseId, toolName, input);
          proc.sendLine({
            type: 'resolve_permission',
            toolUseId,
            allow: result.behavior === 'allow',
            message: result.behavior === 'deny' ? result.message : undefined,
            scope: result.behavior === 'allow' ? result.scope : undefined,
          });
        })();
      };

      // Pre-register so events for this turn have a destination from the
      // get-go. Without pre-registration there's a tiny window between
      // sendLine and registerTurn where agent-server's first response
      // could arrive and get dropped as "unknown turn".
      const events = proc.registerTurn(turnId, permissionHandler);

      // Opts are authoritative — renderer reads savedPrefs / statusModel /
      // currentEffort / permissionMode and sends them with every AGENT_SEND
      // IPC. No closure cache in this layer; agent-server orchestrator
      // diff-detects per-session and calls provider.setModel etc on change.
      proc.sendLine({
        type: 'send',
        turnId,
        provider,
        prompt,
        cwd,
        sessionId,
        resume: opts?.resume,
        permissionMode: opts?.permissionMode,
        model: opts?.model,
        effort: opts?.effort,
        images: opts?.images,
        configEdit: opts?.configEdit,
      });

      yield* events;
    },

    async stop() {
      if (remoteProc) {
        remoteProc.sendLine({ type: 'stop' });
      }
    },

    dispose() {
      if (remoteProc) {
        remoteProc.kill();
        remoteProc = null;
      }
      initInFlight = null; // so a later ensureProcReady re-spawns instead of returning the dead proc
    },

    clearContext() {
      if (sessionId && remoteProc) {
        remoteProc.sendLine({ type: 'clear_context', sessionId });
      }
    },

    resolvePicker(pickerId: string, payload: PickerResolvePayload) {
      if (!remoteProc) return;
      remoteProc.sendLine({ type: 'resolve_picker', pickerId, payload });
    },

    async getCapabilities(
      cwd: string,
      customModels?: ProviderModel[],
      intent?: { model?: string; effort?: string; permissionMode?: string },
    ) {
      const proc = await ensureProcReady(cwd);
      // 失敗時 throw 而非回空 capabilities — 讓 startSession 的 .catch 能區分
      // 「真的沒能力」跟「啟動失敗」，並對應送 init_status=failed 給 renderer。
      if (!proc) throw new Error('Failed to start agent-server');
      const requestId = `cap-${Date.now()}`;
      return new Promise<import('./types').ProviderCapabilities>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ models: [], permissionModes: [], effortLevels: [], slashCommands: [] });
        }, 30000);
        proc.onResponse(requestId, 'capabilities', (payload) => {
          clearTimeout(timeout);
          resolve({
            models: payload.models ?? [],
            permissionModes: payload.permissionModes ?? [],
            effortLevels: payload.effortLevels ?? [],
            slashCommands: payload.slashCommands ?? [],
            authMethod: payload.authMethod,
            currentModel: payload.currentModel,
            currentEffort: payload.currentEffort,
            currentPermissionMode: payload.currentPermissionMode,
            authRequired: payload.authRequired,
          });
        });
        // `intent` lets agent-server's provider seed session-level closures
        // (e.g. Copilot's currentPermissionMode) before reporting caps back.
        onPhase?.('checking-auth');
        proc.sendLine({ type: 'get_capabilities', provider, cwd, sessionId, customModels, intent, requestId });
      });
    },

    async readTaskOutput(taskId: string): Promise<string> {
      // Reuse the already-running session process — don't spawn just to read a
      // log. The panel only shows tasks after a turn ran, so remoteProc is set.
      const proc = remoteProc;
      if (!proc) throw new Error('agent-server not running');
      const requestId = `tout-${randomUUID().slice(0, 8)}`;
      return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('read_task_output timed out')), 15000);
        proc.onResponse(requestId, 'task_output', (payload) => {
          clearTimeout(timeout);
          if (payload.error) reject(new Error(payload.error));
          else resolve(payload.content ?? '');
        });
        proc.sendLine({ type: 'read_task_output', provider, taskId, requestId });
      });
    },
  };

  return backend;
}

export function toWslPath(winPath: string): string {
  return winPath
    .replace(/^([A-Za-z]):\\/, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`)
    .replace(/\\/g, '/');
}

function getAppVersion(): string {
  return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf-8')).version;
}

function getLocalBundlePath(): string {
  const version = getAppVersion();
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent-server', version, 'index.mjs');
  }
  return path.join(app.getAppPath(), 'dist', 'agent-server', version, 'index.mjs');
}

/**
 * Per-connection primitives for the self-contained deploy. `base` is the home
 * the deploy root hangs off (`~` expands in the remote shell for ssh; docker
 * has no per-user home shell so we use `/root`). `exec` runs a command on the
 * target and returns stdout; `copyIn` transfers a local file to the target.
 */
interface RemoteOps {
  base: string;
  exec(cmd: string, timeoutMs?: number): string;
  copyIn(localPath: string, remotePath: string, timeoutMs?: number): void;
}

/** Single-quote a string for safe embedding inside an outer single-quoted shell arg. */
function sq(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

function sshOps(c: Extract<Connection, { type: 'ssh' }>): RemoteOps {
  const target = `${c.user}@${c.host}`;
  const opts = ['-o', 'ControlMaster=auto', '-o', `ControlPath=/tmp/shelf-ssh-${c.host}-${c.port}-${c.user}`, '-o', 'ControlPersist=600', '-p', String(c.port)];
  const optStr = opts.map((o) => `'${o}'`).join(' ');
  return {
    base: '~',
    exec: (cmd, t = 15000) => execSync(`ssh ${optStr} ${target} '${sq(cmd)}'`, { timeout: t, encoding: 'utf8' }),
    copyIn: (local, remote, t = 180000) => {
      execSync(`scp ${optStr} '${local}' ${target}:'${sq(remote)}'`, { timeout: t });
    },
  };
}

function dockerOps(c: Extract<Connection, { type: 'docker' }>): RemoteOps {
  return {
    base: '/root',
    exec: (cmd, t = 15000) => execSync(`docker exec ${c.container} sh -c '${sq(cmd)}'`, { timeout: t, encoding: 'utf8' }),
    copyIn: (local, remote, t = 180000) => {
      execSync(`docker cp '${local}' ${c.container}:'${sq(remote)}'`, { timeout: t });
    },
  };
}

/**
 * WSL RemoteOps: a Linux distro reached via `wsl.exe`, so the self-contained
 * model (ship our own node + provider binary, exactly like ssh/docker) applies.
 *
 * Quoting note: unlike sshOps/dockerOps (which run as a single `execSync`
 * string), we invoke `wsl.exe` via `execFileSync` with an ARGV ARRAY. The host
 * shell on Windows is cmd.exe, which does NOT understand the POSIX single-quote
 * wrapping ssh/docker rely on — passing args as an array bypasses host-shell
 * parsing entirely (same approach as `spawnAgentServer`'s WSL branch). The inner
 * `sh -c <cmd>` still does normal POSIX quoting/`~` expansion inside the distro.
 *
 * copyIn reads the Windows-side cached file via /mnt (toWslPath) and `cp`s it
 * into the deploy root. The Claude binary is ~215MB; the /mnt bridge can be slow
 * — if it ever becomes a problem, switch to a native-fs transfer.
 *
 * `base` is an ABSOLUTE home, NOT `~`: deploy paths get single-quoted (e.g. the
 * remote arg in copyIn), and a tilde inside single quotes does NOT expand in
 * POSIX sh. ssh gets away with `~` because scp expands it on the remote; we
 * mirror dockerOps instead and resolve `$HOME` up front.
 */
function wslOps(c: Extract<Connection, { type: 'wsl' }>): RemoteOps {
  const run = (cmd: string, t: number): string =>
    execFileSync('wsl.exe', ['-d', c.distro, '--', 'sh', '-c', cmd], { timeout: t, encoding: 'utf8' });
  const home = run('echo "$HOME"', 15000).trim();
  if (!home) throw new Error(`WSL distro ${c.distro}: could not resolve $HOME`);
  return {
    base: home,
    exec: (cmd, t = 15000) => run(cmd, t),
    copyIn: (local, remote, t = 180000) => {
      run(`cp '${sq(toWslPath(local))}' '${sq(remote)}'`, t);
    },
  };
}

/** One round-trip: list which deploy files + sentinel already exist on the target. */
function readRemoteInventory(ops: RemoteOps, root: string): RemoteInventory {
  // List the root and test membership — do NOT use a remote `for f in …; echo $f`
  // loop. Over WSL's `wsl.exe -- sh -c <cmd>` the loop variable comes back EMPTY
  // (`$f` expands to nothing), so every file looked absent and `needsDeploy` was
  // always true → a full ~215MB redeploy on every connect. `ls -a` carries no
  // remote shell variable and is known to survive wsl.exe. `|| true` keeps exit 0
  // on a fresh target whose root doesn't exist yet (ls would otherwise non-zero
  // and make ops.exec throw).
  const out = ops.exec(`ls -a ${root} 2>/dev/null || true`);
  const present = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  const files: Partial<Record<DeployFile, boolean>> = {};
  for (const f of DEPLOY_FILES) files[f] = present.has(f);
  return { sentinel: present.has(DEPLOYED_SENTINEL), files };
}

/**
 * Self-contained deploy (ssh/docker): probe the target's arch+libc, ensure the
 * matching Node + Claude binaries are cached locally, then incrementally ship
 * {node, index.mjs, claude} to a versioned root. The `.deployed` sentinel is
 * written LAST so a half-finished transfer never looks complete.
 */
async function deploySelfContained(connection: Connection, ops: RemoteOps, providerBin: ProviderBin): Promise<DeployResult> {
  const version = getAppVersion();
  const root = deployRoot(ops.base, version);

  // Probe arch+libc (throws UnsupportedTargetError on unknown arch/libc).
  const target = detectTargetFromProbe(ops.exec(TARGET_PROBE_CMD));
  const isMusl = target.libc === 'musl';

  // glibc → run on the Node we ship (<root>/node). musl → run on the remote's
  // own node (no official musl Node to ship), gated on a minimum version.
  let nodeBin: string;
  if (isMusl) {
    const ver = ops.exec('node --version 2>/dev/null || true').trim();
    if (!ver) {
      throw new Error(
        `Remote (${targetId(target)}) has no node on PATH. Install Node >= ${MIN_REMOTE_NODE_MAJOR}, or use a glibc remote (we ship Node there).`,
      );
    }
    if (!isRemoteNodeSupported(ver)) {
      throw new Error(`Remote node ${ver} is too old (${targetId(target)} uses the remote's node; needs >= ${MIN_REMOTE_NODE_MAJOR}).`);
    }
    nodeBin = 'node';
  } else {
    nodeBin = `${root}/node`;
  }
  const result: DeployResult = { nodeBin, indexPath: `${root}/index.mjs` };

  const expected = deployFilesFor(target.libc, providerBin);
  const inv = readRemoteInventory(ops, root);
  if (!needsDeploy(inv, expected)) {
    log.info('agent-remote', `agent-server already deployed at ${root} (${targetId(target)}, ${providerBin})`);
    return result;
  }

  // Cache root defaults to userData; SHELF_RUNTIME_CACHE_DIR lets E2E (which
  // uses a throwaway userData per run) reuse downloads across runs.
  const cacheRoot = process.env.SHELF_RUNTIME_CACHE_DIR || app.getPath('userData');
  const indexLocal = getLocalBundlePath();
  if (!fs.existsSync(indexLocal)) {
    throw new Error(`Agent-server bundle not found at ${indexLocal}. Run: node agent-server/build.mjs`);
  }
  // Only the files this target+provider ships (musl omits node; binary = provider).
  const sources: Partial<Record<DeployFile, string>> = { 'index.mjs': indexLocal };
  if (!isMusl) sources.node = await ensureNodeCached(cacheRoot, target);
  if (providerBin === 'copilot') {
    sources.copilot = await ensureCopilotCached(cacheRoot, target, COPILOT_CLI_VERSION);
  } else {
    sources.claude = await ensureClaudeCached(cacheRoot, target, CLAUDE_SDK_VERSION);
  }

  ops.exec(`mkdir -p ${root}`);
  for (const f of missingFiles(inv, expected)) {
    ops.copyIn(sources[f]!, `${root}/${f}`);
  }
  // Exec bits on what we shipped (node only for glibc; the provider binary).
  const execBits = [isMusl ? null : `${root}/node`, `${root}/${providerBin}`].filter(Boolean).join(' ');
  ops.exec(`chmod +x ${execBits}`);
  ops.exec(`touch ${root}/${DEPLOYED_SENTINEL}`); // completion marker — last
  log.info('agent-remote', `Deployed agent-server to ${root} (${targetId(target)}, ${isMusl ? 'remote node' : 'own node'})`);

  // Best-effort: drop the pre-R1 flat orphan (`index.mjs`/`index.js` directly
  // under agent-server/) and stale version dirs (~300MB each). Never fails the
  // deploy (decision C); current version is preserved via the case-skip.
  try {
    const dir = agentServerDir(ops.base);
    ops.exec(
      `D="${dir}"; rm -f "$D/index.mjs" "$D/index.js" 2>/dev/null; ` +
        `for p in "$D"/*/; do [ -d "$p" ] || continue; case "$p" in */${version}/) ;; *) rm -rf "$p" 2>/dev/null;; esac; done; true`,
    );
  } catch (err: any) {
    log.info('agent-remote', `old-artifact cleanup skipped: ${err?.message ?? err}`);
  }
  return result;
}

async function deployAgentServer(connection: Connection, provider: AgentProvider): Promise<DeployResult> {
  // local: use the host's own node (no version-drift problem on your own box).
  if (connection.type === 'local') {
    return { nodeBin: 'node', indexPath: getLocalBundlePath() };
  }
  const providerBin: ProviderBin = provider === 'copilot' ? 'copilot' : 'claude';
  // ssh / docker: ship our own runtime + provider binary.
  if (connection.type === 'ssh') {
    return deploySelfContained(connection, sshOps(connection), providerBin);
  }
  if (connection.type === 'docker') {
    return deploySelfContained(connection, dockerOps(connection), providerBin);
  }
  if (connection.type === 'wsl') {
    // Self-contained, like ssh/docker: ship our own node (glibc) + provider
    // binary into the distro via wslOps. (Pre-R1 WSL ran on the distro's own
    // node against the Windows bundle via /mnt and shipped NO provider binary,
    // so agents couldn't find their CLI — that legacy path is gone.)
    return deploySelfContained(connection, wslOps(connection), providerBin);
  }
  throw new Error(`Unsupported connection type for deploy: ${(connection as any).type}`);
}

async function spawnAgentServer(
  connection: Connection,
  cwd: string,
  deploy: DeployResult,
  initScript?: string,
  onTaskEvent?: (ev: TaskEvent) => void,
  onServerTurn?: (turnId: string, events: AsyncGenerator<AgentEvent>) => void,
): Promise<RemoteProcess | null> {
  const { nodeBin, indexPath } = deploy;
  // Forward SHELF_TEST_MODE to the remote agent-server so E2E specs can drive
  // the fake provider over ssh/docker (prod leaves it unset → empty prefix).
  const testEnv = process.env.SHELF_TEST_MODE ? `SHELF_TEST_MODE=${process.env.SHELF_TEST_MODE} ` : '';

  if (connection.type === 'local') {
    try {
      const env: Record<string, string> = { ...getShellEnv() };
      if (process.env.SHELF_TEST_MODE) env.SHELF_TEST_MODE = process.env.SHELF_TEST_MODE;
      log.trace(
        'agent-remote',
        `spawnAgentServer local: cwd=${cwd} indexPath=${indexPath} fileExists=${fs.existsSync(indexPath)} PATH=${env.PATH ?? '<missing>'}`,
      );
      const proc = spawn(nodeBin, [indexPath], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      return wrapProcess(proc, onTaskEvent, onServerTurn);
    } catch (err: any) {
      log.error('agent-remote', `Local spawn failed: ${err.message}`);
      return null;
    }
  }

  if (connection.type === 'ssh') {
    const shellPrefix = initScript
      ? `eval '${initScript.replace(/'/g, "'\\''")}' >/dev/null 2>&1; `
      : '';
    const cmd = `${shellPrefix}${testEnv}exec ${nodeBin} ${indexPath}`;
    const args = [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=/tmp/shelf-ssh-${connection.host}-${connection.port}-${connection.user}`,
      '-o', 'ControlPersist=600',
      '-p', String(connection.port),
      `${connection.user}@${connection.host}`,
      cmd,
    ];
    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    return wrapProcess(proc, onTaskEvent, onServerTurn);
  }

  if (connection.type === 'docker') {
    const cmd = `${testEnv}exec ${nodeBin} ${indexPath}`;
    const proc = spawn('docker', ['exec', '-i', connection.container, 'sh', '-c', cmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return wrapProcess(proc, onTaskEvent, onServerTurn);
  }

  if (connection.type === 'wsl') {
    const proc = spawn('wsl.exe', ['-d', connection.distro, '--', 'sh', '-lc', `${testEnv}exec ${nodeBin} ${indexPath}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return wrapProcess(proc, onTaskEvent, onServerTurn);
  }

  return null;
}

function wrapProcess(
  proc: ChildProcess,
  onTaskEvent?: (ev: TaskEvent) => void,
  onServerTurn?: (turnId: string, events: AsyncGenerator<AgentEvent>) => void,
): RemoteProcess {
  const dispatcher = createTurnDispatcher(parseRemoteMessage, onTaskEvent, onServerTurn);
  let buffer = '';

  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        log.info('agent-remote', `non-json line from agent-server, dropping: ${trimmed.slice(0, 100)}`);
        continue;
      }
      dispatcher.feed(parsed);
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    log.error('agent-remote', 'stderr:', chunk.toString());
  });

  proc.on('exit', (code) => {
    log.info('agent-remote', `Process exited with code ${code}`);
  });

  // spawn() 對 ENOENT 等失敗是非同步 emit 'error' event，try/catch 抓不到；
  // 沒掛 listener 會升級成 uncaught exception 把 main process 撞掉。
  // 觸發時 flush trace buffer，把 shell-env / spawn 的 PATH 等診斷資訊倒進 log。
  proc.on('error', (err) => {
    log.error('agent-remote', `Process error: ${err.message}`);
    log.flushTrace('agent-remote', `proc error: ${err.message}`);
  });

  return {
    sendLine: (msg) => {
      proc.stdin?.write(JSON.stringify(msg) + '\n');
    },
    registerTurn: dispatcher.registerTurn,
    awaitReady: dispatcher.awaitReady,
    onResponse: dispatcher.onResponse,
    kill: () => {
      proc.stdin?.end();
      proc.kill();
    },
  };
}

export function parseRemoteMessage(msg: any): AgentEvent | null {
  if (msg.type === 'message') {
    // Construct discriminated union by msgType — each variant only exposes the
    // fields it actually needs. Provider is responsible for sending matching
    // shape; unknown msgType returns null (caller drops the message).
    const payload = buildAgentMessagePayload(msg);
    if (!payload) return null;
    // Server-initiated turn marker (auto-resume prose) — pass through so the
    // renderer opens a new turn block for it. See background-tasks.md M3.
    if (msg.startsTurn) payload.startsTurn = true;
    return { type: 'message', payload };
  }

  if (msg.type === 'plan') {
    return { type: 'plan', content: typeof msg.content === 'string' ? msg.content : '' };
  }

  if (msg.type === 'capabilities') {
    // Mid-turn capabilities (e.g. /model slash, provider model promotion).
    // Mirror the field extraction used by getCapabilities()'s RPC response so
    // the renderer's setCapabilities gets the same shape.
    return {
      type: 'capabilities',
      caps: {
        models: msg.models ?? [],
        permissionModes: msg.permissionModes ?? [],
        effortLevels: msg.effortLevels ?? [],
        slashCommands: msg.slashCommands ?? [],
        authMethod: msg.authMethod,
        currentModel: msg.currentModel,
        currentEffort: msg.currentEffort,
        currentPermissionMode: msg.currentPermissionMode,
        authRequired: msg.authRequired,
      },
    };
  }

  if (msg.type === 'status') {
    return {
      type: 'status',
      payload: {
        state: msg.state,
        model: msg.model,
        costUsd: msg.costUsd,
        inputTokens: msg.inputTokens,
        outputTokens: msg.outputTokens,
        numTurns: msg.numTurns,
        sessionId: msg.sessionId,
        contextUsage: msg.contextUsage,
        rateLimits: msg.rateLimits,
      },
    };
  }

  if (msg.type === 'stream') {
    return {
      type: 'stream',
      payload: {
        msgId: msg.msgId ?? `legacy-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: msg.streamType ?? 'text',
        content: msg.content ?? '',
      },
    };
  }

  if (msg.type === 'auth_required') {
    return { type: 'auth_required', provider: msg.provider ?? 'copilot' };
  }

  if (msg.type === 'picker_request') {
    if (typeof msg.id !== 'string' || !Array.isArray(msg.prompts)) {
      return null;
    }
    // Defensive validation — each prompt must have a question + options array.
    // Skip the whole message on malformed payload rather than render half a UI.
    const prompts = msg.prompts.map((p: any) => {
      if (!p || typeof p.question !== 'string' || !Array.isArray(p.options)) return null;
      return {
        question: p.question,
        header: typeof p.header === 'string' ? p.header : undefined,
        multiSelect: !!p.multiSelect,
        options: p.options.map((o: any) => ({
          label: typeof o?.label === 'string' ? o.label : '',
          description: typeof o?.description === 'string' ? o.description : undefined,
          preview: typeof o?.preview === 'string' ? o.preview : undefined,
        })),
        inputType: p.inputType === 'text' || p.inputType === 'number' || p.inputType === 'integer'
          ? p.inputType
          : undefined,
        currentValue: Array.isArray(p.currentValue) || typeof p.currentValue === 'string'
          ? p.currentValue
          : undefined,
      };
    });
    if (prompts.some((p: unknown) => p === null)) return null;
    return {
      type: 'picker_request',
      id: msg.id,
      prompts: prompts as Array<NonNullable<typeof prompts[number]>>,
    };
  }

  if (msg.type === 'error') {
    // Log to file for postmortem — these errors are otherwise only surfaced
    // to the renderer via IPC and disappear when the session ends.
    log.error('agent-remote', 'remote error:', msg.error ?? 'Unknown remote error');
    return { type: 'error', error: msg.error ?? 'Unknown remote error' };
  }

  return null;
}

/**
 * Build a canonical `AgentMessage` from the raw wire payload's msgType.
 * Returns null for unknown / unsupported msgType so callers can drop them
 * cleanly instead of forwarding ill-shaped payloads to the renderer.
 */
function buildAgentMessagePayload(msg: any): import('./types').AgentMessage | null {
  const t = msg.msgType;
  // msgId is the universal upsert key (provider-minted).
  const msgId: string = msg.msgId ?? `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  switch (t) {
    case 'reply':
    case 'note':
    case 'system':
    case 'error':
      return { msgId, type: t, content: msg.content ?? '' };
    case 'fold_text': {
      if (typeof msg.label !== 'string') return null;
      return {
        msgId,
        type: 'fold_text',
        label: msg.label,
        ...(typeof msg.subtitle === 'string' ? { subtitle: msg.subtitle } : {}),
        ...(typeof msg.errorMessage === 'string' ? { errorMessage: msg.errorMessage } : {}),
        ...(msg.body && typeof msg.body.content === 'string'
          ? { body: { content: msg.body.content, ...(msg.body.tone === 'muted' ? { tone: 'muted' as const } : {}) } }
          : {}),
      };
    }
    case 'fold_code': {
      if (typeof msg.label !== 'string') return null;
      return {
        msgId,
        type: 'fold_code',
        label: msg.label,
        ...(typeof msg.subtitle === 'string' ? { subtitle: msg.subtitle } : {}),
        ...(typeof msg.errorMessage === 'string' ? { errorMessage: msg.errorMessage } : {}),
        ...(msg.body && typeof msg.body.content === 'string' ? { body: { content: msg.body.content } } : {}),
      };
    }
    case 'fold_markdown': {
      if (typeof msg.label !== 'string') return null;
      return {
        msgId,
        type: 'fold_markdown',
        label: msg.label,
        ...(typeof msg.subtitle === 'string' ? { subtitle: msg.subtitle } : {}),
        ...(typeof msg.errorMessage === 'string' ? { errorMessage: msg.errorMessage } : {}),
        ...(msg.body && typeof msg.body.content === 'string' ? { body: { content: msg.body.content } } : {}),
      };
    }
    case 'fold_diff': {
      if (typeof msg.label !== 'string') return null;
      return {
        msgId,
        type: 'fold_diff',
        label: msg.label,
        ...(typeof msg.subtitle === 'string' ? { subtitle: msg.subtitle } : {}),
        ...(typeof msg.errorMessage === 'string' ? { errorMessage: msg.errorMessage } : {}),
        ...(msg.body && msg.body.diff
          && typeof msg.body.diff.oldString === 'string'
          && typeof msg.body.diff.newString === 'string'
          ? { body: { diff: { oldString: msg.body.diff.oldString, newString: msg.body.diff.newString } } }
          : {}),
      };
    }
    default:
      return null;
  }
}
