import { log } from '@shared/logger';
import type { Connection, AgentProvider, AgentInitPhase, AgentQueueItem, ProviderModel, TaskEvent, ConnectionHealth, ConnectionHealthState } from '@shared/types';
import type { AgentBackend, AgentEvent, AgentQueryOptions, PickerResolvePayload } from './types';
import { ConnectionHealthTracker, DEFAULT_HEALTH_THRESHOLDS } from './connection-health';
import { ChildProcess, spawn, execSync, execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getShellEnv } from '../connector/shell-env';
import { resolveProjectEnv } from '../project-env';
import { buildEnvExportPrefix, applyEnvMap, type EnvMap } from '@shared/project-env';
import { createTurnDispatcher, type PermissionHandler } from './turn-dispatcher';
import { createDispatcherConnection, type DispatcherConnection, type DispatcherProc } from './dispatcher-connection';
import { getAppInstanceId } from '../app-instance-id';
import { skillsSourceRoot, listSkillFilesRel, hashSkillsTree } from '../skills-projection';
import { syncMcpForConnection } from '../mcp-remote';
import { transportPutDir, composeRemotePath } from '../connector/transport';
import { shelfPlacement, ShelfFileTypeSkill } from '@shared/shelf-paths';
import { handleAppTool } from './app-tool';
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
  // outlives the turn that spawned it. See background-tasks#2.
  onTaskEvent?: (ev: TaskEvent) => void,
  // Optional sink for a server-initiated turn (auto-resume prose after a
  // background task finishes). Receives the turnId + the turn's event
  // generator to drain into the renderer. See background-tasks#2.
  onServerTurn?: (turnId: string, events: AsyncGenerator<AgentEvent>) => void,
  // Optional per-connection health sink — main wires it to
  // AGENT_CONNECTION_HEALTH. Driven by the heartbeat round-trip (see §5.9 /
  // connection-health.ts). Fires only on health-state change.
  onHealth?: (health: ConnectionHealth) => void,
  // Optional session-level sink for the server-owned send-queue snapshot. Main
  // wires it to IPC.AGENT_QUEUE. Session-scoped (turnId-less), like onTaskEvent.
  // See message-queue-ownership.
  onQueue?: (items: AgentQueueItem[]) => void,
  // Optional session-level sink for an app-skill reload result. Main wires it to
  // a system/error AGENT_MESSAGE in this tab's view. turnId-less, like onQueue.
  // See skill-reload feedback.
  onSkillsReloaded?: (ok: boolean, error?: string) => void,
  // Optional session-level sink for DISPLAY events delivered by tabId instead of
  // the per-turn generator (Phase 2 turnId-scoping). Main wires it to
  // dispatchEvent. See turnId-scoping.
  onSessionEvent?: (event: AgentEvent) => void,
  // Owning project id — threaded into the app_tool bridge so the web.fetch gate
  // can key its grant on (projectId, origin). Connection-agnostic; defaults empty.
  projectId?: string,
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
  // Last init failure message, so the UI shows the real cause (e.g. a stale-package
  // bundle-missing error) instead of the generic "Failed to start agent-server".
  let lastInitError: string | null = null;

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
        // Project-level env (plain + decrypted secrets), injected into the
        // agent-server (+ the CLIs it spawns). Resolved per-session: the
        // dispatcher is shared per-host, so this rides open_session, not the
        // dispatcher's own env. See context/project-env#2.
        const projectEnv = resolveProjectEnv(projectId);
        let proc: RemoteProcess | null;
        if (USE_DISPATCHER) {
          // Shared per-host dispatcher: open a session on it (drop-in RemoteProcess).
          const dc = ensureDispatcher(connection, cwd, deployResult!, initScript);
          const sid = sessionId ?? randomUUID();
          proc = dc
            ? dc.openSession(sid, cwd, { onTaskEvent, onServerTurn, onHealth, onQueue, onSkillsReloaded, onSessionEvent, projectId }, projectEnv)
            : null;
        } else {
          proc = await spawnAgentServer(connection, cwd, deployResult!, initScript, projectEnv, onTaskEvent, onServerTurn, onHealth, onQueue, onSkillsReloaded, onSessionEvent, projectId);
        }
        if (!proc) return null;
        const ready = await proc.awaitReady();
        if (!ready) {
          proc.kill();
          return null;
        }
        remoteProc = proc;
        lastInitError = null;
        return proc;
      })().catch((err: any) => {
        lastInitError = err?.message ?? String(err);
        log.error('agent-remote', `Init failed: ${lastInitError}`);
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
        yield { type: 'error', error: lastInitError ?? 'Failed to start agent-server' };
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
            proc.sendLine({ type: 'resolve_permission', sid: sessionId, toolUseId, allow: true });
            return;
          }
          const result = await userCallback(toolUseId, toolName, input);
          proc.sendLine({
            type: 'resolve_permission',
            sid: sessionId,
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
        clientMsgId: opts?.clientMsgId,
        // Names this app's projected skills dir (~/.shelf/apps/<appId>/skills)
        // for the provider to point its SDK at. See #70.
        appId: getAppInstanceId(),
      });

      yield* events;
    },

    async stop() {
      if (remoteProc) {
        remoteProc.sendLine({ type: 'stop' });
      }
    },

    async stopTask(taskId: string) {
      // Fire-and-forget: agent-server forwards to the provider; the resulting
      // 'stopped' task_notification flows back over the task_event lane.
      if (remoteProc) {
        remoteProc.sendLine({ type: 'stop_task', sid: sessionId, taskId });
      }
    },

    cancelQueued(clientMsgId: string) {
      // Fire-and-forget: agent-server drops the matching not-yet-running send
      // from its queue + re-emits the queue snapshot. No-op if already running.
      if (remoteProc) {
        remoteProc.sendLine({ type: 'cancel_queued', clientMsgId });
      }
    },

    reloadSkills() {
      // Fire-and-forget: agent-server asks every live provider session to
      // re-scan its app-skill dir so an app-level skill edit lands without
      // reconnect. No-op if the process isn't up. See DECISIONS (skill reload).
      if (remoteProc) {
        remoteProc.sendLine({ type: 'reload_skills' });
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

    startLogin(cwd: string) {
      // Ensure the agent-server is up (login may be the FIRST thing the user does
      // on a fresh, unauthenticated tab), then fire the command. The resulting
      // auth_login_prompt / auth_login_done flow back via onSessionEvent. On init
      // failure, surface a done(ok:false) so the UI doesn't hang on "waiting".
      void ensureProcReady(cwd).then((proc) => {
        if (!proc) {
          onSessionEvent?.({ type: 'auth_login_done', provider, ok: false, error: lastInitError ?? 'Failed to start agent-server' });
          return;
        }
        proc.sendLine({ type: 'start_login', provider, cwd, sid: sessionId });
      });
    },

    cancelLogin() {
      if (remoteProc) {
        remoteProc.sendLine({ type: 'cancel_login', provider, sid: sessionId });
      }
    },

    resolvePicker(pickerId: string, payload: PickerResolvePayload) {
      if (!remoteProc) return;
      remoteProc.sendLine({ type: 'resolve_picker', sid: sessionId, pickerId, payload });
    },

    async getCapabilities(
      cwd: string,
      customModels?: ProviderModel[],
      intent?: { model?: string; effort?: string; permissionMode?: string },
    ) {
      const proc = await ensureProcReady(cwd);
      // 失敗時 throw 而非回空 capabilities — 讓 startSession 的 .catch 能區分
      // 「真的沒能力」跟「啟動失敗」，並對應送 init_status=failed 給 renderer。
      if (!proc) throw new Error(lastInitError ?? 'Failed to start agent-server');
      const requestId = `cap-${Date.now()}`;
      return new Promise<import('./types').ProviderCapabilities>((resolve, reject) => {
        const timeout = setTimeout(() => {
          // Fail-loud + fail-closed. A caps RPC that never answers means the
          // agent-server ↔ Copilot CLI/SDK link is unhealthy — and we can't tell
          // "slow listModels" (turns would still work) from "CLI spawn hung"
          // (turns dead too), because ensureClient is shared. REJECT instead of
          // resolving empty caps: startSession's .catch marks init 'failed' →
          // the input stays locked + Retry shows, rather than faking a 'ready'
          // pane the user can send into. See agent-config-flow (init readiness).
          log.warn('agent-remote', `getCapabilities RPC timed out after 30s (${provider}) reqId=${requestId} — failing init (SDK link unhealthy)`);
          reject(new Error('getCapabilities timed out after 30s — agent-server did not respond'));
        }, 30000);
        proc.onResponse(requestId, 'capabilities', (payload) => {
          clearTimeout(timeout);
          // Same rule for an explicit error payload (gatherCapabilities threw in
          // the child): reject, don't swallow into empty caps.
          if ((payload as any).error) {
            log.warn('agent-remote', `getCapabilities RPC returned error (${provider}) reqId=${requestId}: ${(payload as any).error} — failing init`);
            reject(new Error((payload as any).error));
            return;
          }
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
 * The local agent-server bundle is required both to spawn (local run) and to
 * ship (remote deploy). When it's missing the raw failure is a cryptic node
 * MODULE_NOT_FOUND deep inside a spawned process, surfaced to the user only as
 * a generic "Failed to start agent-server". The commonest cause is a STALE
 * PACKAGED APP: the version was bumped but the app wasn't repackaged, so
 * `agent-server/<newVersion>/index.mjs` doesn't exist next to the old binary.
 * fail-loud with the version, the resolved path, and the concrete next step so
 * nobody has to read the logger to understand it.
 */
export function agentBundleMissingMessage(indexPath: string): string {
  const version = getAppVersion();
  const hint = app.isPackaged
    ? 'the app package is out of date — reinstall or rebuild it (npm run dist)'
    : 'run: node agent-server/build.mjs';
  return `Agent-server ${version} bundle not found at ${indexPath} — ${hint}`;
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

/**
 * Build the quoted `ssh` and `scp` option strings for the deploy commands.
 * Shared ControlMaster opts + the port — but the port flag DIFFERS by tool:
 * `ssh -p <port>` vs `scp -P <port>`. `scp -p` means "preserve times" and would
 * swallow the port as a source operand (`scp: stat local "2222": No such file`),
 * breaking the deploy on any non-default port. Exported for a regression test.
 */
export function sshDeployOptStrings(c: { host: string; port: number; user: string }): { ssh: string; scp: string } {
  const base = ['-o', 'ControlMaster=auto', '-o', `ControlPath=/tmp/shelf-ssh-${c.host}-${c.port}-${c.user}`, '-o', 'ControlPersist=600'];
  const quote = (arr: string[]) => arr.map((o) => `'${o}'`).join(' ');
  return {
    ssh: quote([...base, '-p', String(c.port)]),
    scp: quote([...base, '-P', String(c.port)]),
  };
}

function sshOps(c: Extract<Connection, { type: 'ssh' }>): RemoteOps {
  const target = `${c.user}@${c.host}`;
  const { ssh: sshOptStr, scp: scpOptStr } = sshDeployOptStrings(c);
  const exec = (cmd: string, t = 15000): string =>
    execSync(`ssh ${sshOptStr} ${target} '${sq(cmd)}'`, { timeout: t, encoding: 'utf8' });
  const copyIn = (local: string, remote: string, t = 180000): void => {
    execSync(`scp ${scpOptStr} '${local}' ${target}:'${sq(remote)}'`, { timeout: t });
  };
  // Resolve an ABSOLUTE $HOME up front (mirroring wslOps), NOT `base:'~'`. The
  // exec-built control commands embed the base inside DOUBLE quotes (e.g.
  // `mkdir -p "<base>/.shelf/..."`), and a `~` inside double quotes does NOT
  // expand in POSIX sh — it would target a literal `~` dir, diverging from the
  // byte path (the connector resolves an absolute home via homePath()). scp gets
  // away with `~` only because it expands it remotely; the exec cmds do not.
  const home = exec('echo "$HOME"').trim();
  if (!home) throw new Error(`SSH ${target}: could not resolve $HOME`);
  return { base: home, exec, copyIn };
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
  if (!fs.existsSync(indexLocal)) throw new Error(agentBundleMissingMessage(indexLocal));
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
  // under agent-server/). Stale VERSION dirs are NO LONGER deleted here — the
  // old "delete every dir but the current version" loop thrashed when two apps
  // on different versions shared a remote (each deploy nuked the other's in-use
  // version → re-deploy → re-nuke). Version reclamation now runs in agent-server
  // at startup via the heartbeat-lease sweep (agent-server/cleanup.ts; #70/§5.9),
  // which never deletes a version another live agent-server is using.
  try {
    const dir = agentServerDir(ops.base);
    ops.exec(`rm -f "${dir}/index.mjs" "${dir}/index.js" 2>/dev/null; true`);
  } catch (err: any) {
    log.info('agent-remote', `flat-orphan cleanup skipped: ${err?.message ?? err}`);
  }
  return result;
}

/**
 * Mirror the app-level skills source onto the remote at
 * `<base>/.shelf/apps/<appId>/skills` (the path the remote agent-server
 * self-resolves via os.homedir() — see #70/§5.7). Whole-tree replace, gated by a
 * content-hash `.synced` sentinel so unchanged skills skip the transfer. Small
 * text files copied one-by-one (a few per skill); best-effort — never fails the
 * deploy. Re-runs each time a remote agent tab opens (deploy is per-backend), so
 * reopening the tab picks up skill edits.
 */
async function syncSkillsToRemote(connection: Connection, ops: RemoteOps, appId: string): Promise<void> {
  try {
    const src = skillsSourceRoot();
    if (!fs.existsSync(src)) return;
    const files = listSkillFilesRel(src);
    if (files.length === 0) return;
    const hash = hashSkillsTree(src);
    // Path layout comes from the single source of truth (shelfPlacement), not a
    // hardcoded literal. ops.base is absolute (see sshOps/wslOps), so it agrees
    // with the connector's homePath() that the transport resolves.
    const target = composeRemotePath(ops.base, shelfPlacement(ShelfFileTypeSkill, { appId }).rel);
    const synced = ops.exec(`cat "${target}/.synced" 2>/dev/null || true`).trim();
    if (synced === hash) return; // up to date

    // Mirror semantics: wipe then re-place. Per-file parent mkdir is handled by
    // the transport's putFile, so no subdir pre-creation is needed here.
    ops.exec(`rm -rf "${target}"; mkdir -p "${target}"`);
    // BYTES go through the type-declared transport (one homePath round-trip, then
    // putFile per file) — NOT ops.copyIn. The deploy-plane extras below (.synced
    // hash-gate, .heartbeat lease) stay on ops.exec, layered on top of the put.
    await transportPutDir(connection, {
      type: ShelfFileTypeSkill,
      context: { appId },
      files: files.map((f) => ({ rel: f, localPath: path.join(src, f) })),
    });
    // `.synced` = content-hash gate; `.heartbeat` = freshness lease so the
    // remote agent-server's startup sweep doesn't reclaim this just-synced dir
    // before the first heartbeat (cleanup.ts / §5.9). appDir = parent of skills.
    const appDir = composeRemotePath(ops.base, `.shelf/apps/${appId}`);
    ops.exec(`printf %s '${hash}' > "${target}/.synced"; touch "${appDir}/.heartbeat"`);
    log.info('agent-remote', `Synced ${files.length} skill file(s) to ${target}`);
  } catch (err: any) {
    log.info('agent-remote', `skills sync skipped: ${err?.message ?? err}`);
  }
}

/**
 * Re-mirror the app-level skills onto one already-connected remote, out of band
 * from a tab open (which is when the deploy path normally syncs). Called by the
 * skills-changed pipeline (agent/index.ts subscriber) so an edit reaches live
 * remote agents without reopening the tab. Hash-gated + best-effort inside
 * syncSkillsToRemote; local is a no-op (it re-projects via projectSkillsLocal).
 */
export async function syncSkillsForConnection(connection: Connection): Promise<void> {
  if (connection.type === 'local') return;
  let ops: RemoteOps;
  if (connection.type === 'ssh') ops = sshOps(connection);
  else if (connection.type === 'docker') ops = dockerOps(connection);
  else if (connection.type === 'wsl') ops = wslOps(connection);
  else return;
  await syncSkillsToRemote(connection, ops, getAppInstanceId());
}

/**
 * Local agent-server runs on ELECTRON's OWN embedded Node — spawn the app
 * binary (`process.execPath`) with `ELECTRON_RUN_AS_NODE=1`, which makes it
 * behave as a plain Node process. This removes any dependency on a system
 * `node` (Windows users needn't install one) and pins the runtime version to
 * Electron's bundled Node, not the user's box. See deployment#4.
 */
export function localNodeExec(): { nodeBin: string; env: Record<string, string> } {
  return { nodeBin: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/**
 * The SINGLE choke point for every LOCAL `process.execPath` spawn in the main
 * process. It always merges `localNodeExec().env` (ELECTRON_RUN_AS_NODE=1) so the
 * app binary runs as plain Node instead of booting a SECOND Electron window.
 *
 * Both local spawn paths — the per-tab agent-server (spawnAgentServer) and the
 * shared dispatcher (spawnDispatcherProc) — MUST route through here. Regression:
 * the dispatcher path once set its env from `getShellEnv()` alone and forgot the
 * flag, which spawned a duplicate app window on connect. Centralizing makes that
 * class of bug unrepresentable. Guarded by remote.test.ts. (ssh/docker/wsl never
 * spawn process.execPath — they run a deployed remote node — so they must NOT and
 * do NOT go through here.)
 */
export function spawnLocalNode(nodeBin: string, args: string[], cwd: string, projectEnv: EnvMap = {}): ChildProcess {
  // Project env merges onto the login-shell env (PATH-merge, reserved dropped);
  // localNodeExec().env is applied LAST so ELECTRON_RUN_AS_NODE can't be overridden.
  // Only the per-tab agent-server passes projectEnv — the shared local dispatcher
  // is per-HOST, so its per-session env rides open_session (applied in dispatcher.ts).
  const env: Record<string, string> = { ...applyEnvMap(getShellEnv(), projectEnv), ...localNodeExec().env };
  if (process.env.SHELF_TEST_MODE) env.SHELF_TEST_MODE = process.env.SHELF_TEST_MODE;
  log.trace('agent-remote', `spawnLocalNode: args=[${args.join(' ')}] cwd=${cwd} PATH=${env.PATH ?? '<missing>'}`);
  return spawn(nodeBin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
}

async function deployAgentServer(connection: Connection, provider: AgentProvider): Promise<DeployResult> {
  // local: run on Electron's embedded Node (see localNodeExec) — no system-node
  // dependency, version pinned to Electron. Local skills go through
  // projectSkillsLocal (agent/index.ts), not here.
  if (connection.type === 'local') {
    const indexPath = getLocalBundlePath();
    // Pre-flight the bundle (the remote path already does — see deploySelfContained).
    // Without this, a stale package's missing bundle only shows up as node's
    // MODULE_NOT_FOUND at spawn → generic "Failed to start agent-server" (deployment#5).
    if (!fs.existsSync(indexPath)) throw new Error(agentBundleMissingMessage(indexPath));
    return { nodeBin: localNodeExec().nodeBin, indexPath };
  }
  const providerBin: ProviderBin = provider === 'copilot' ? 'copilot' : 'claude';
  // ssh / docker / wsl: ship our own runtime + provider binary, then mirror the
  // app-level skills onto the remote (#70/§5.7) so the remote agent loads them.
  let ops: RemoteOps;
  if (connection.type === 'ssh') ops = sshOps(connection);
  else if (connection.type === 'docker') ops = dockerOps(connection);
  else if (connection.type === 'wsl') ops = wslOps(connection);
  else throw new Error(`Unsupported connection type for deploy: ${(connection as any).type}`);

  const result = await deploySelfContained(connection, ops, providerBin);
  // Hold the app-dir lease up front so the agent-server startup sweep doesn't
  // reclaim it before the first heartbeat — UNCONDITIONALLY, not contingent on
  // skills existing (syncSkillsToRemote only touches it when there are skills, so
  // an MCP-only app would otherwise lose its just-placed config to the sweep).
  const appDir = `${ops.base}/.shelf/apps/${getAppInstanceId()}`;
  try { ops.exec(`mkdir -p "${appDir}"; touch "${appDir}/.heartbeat"`); } catch { /* best-effort */ }
  await syncSkillsToRemote(connection, ops, getAppInstanceId());
  // Place the app-level MCP config too (new type-declared transport, not RemoteOps).
  // The link is established here, so the transport's ssh calls reuse the
  // ControlMaster. Best-effort — never fails the deploy.
  try {
    await syncMcpForConnection(connection);
  } catch (err: any) {
    log.info('agent-remote', `mcp sync skipped: ${err?.message ?? err}`);
  }
  return result;
}

async function spawnAgentServer(
  connection: Connection,
  cwd: string,
  deploy: DeployResult,
  initScript?: string,
  projectEnv: EnvMap = {},
  onTaskEvent?: (ev: TaskEvent) => void,
  onServerTurn?: (turnId: string, events: AsyncGenerator<AgentEvent>) => void,
  onHealth?: (health: ConnectionHealth) => void,
  onQueue?: (items: AgentQueueItem[]) => void,
  onSkillsReloaded?: (ok: boolean, error?: string) => void,
  onSessionEvent?: (event: AgentEvent) => void,
  projectId?: string,
): Promise<RemoteProcess | null> {
  const { nodeBin, indexPath } = deploy;
  // Forward SHELF_TEST_MODE to the remote agent-server so E2E specs can drive
  // the fake provider over ssh/docker (prod leaves it unset → empty prefix).
  const testEnv = process.env.SHELF_TEST_MODE ? `SHELF_TEST_MODE=${process.env.SHELF_TEST_MODE} ` : '';

  if (connection.type === 'local') {
    try {
      log.trace(
        'agent-remote',
        `spawnAgentServer local: cwd=${cwd} indexPath=${indexPath} fileExists=${fs.existsSync(indexPath)}`,
      );
      // spawnLocalNode applies ELECTRON_RUN_AS_NODE so the app binary runs as
      // plain Node (never a second Electron window), and merges the project env.
      const proc = spawnLocalNode(nodeBin, [indexPath], cwd, projectEnv);
      return wrapProcess(proc, onTaskEvent, onServerTurn, onHealth, onQueue, onSkillsReloaded, onSessionEvent, projectId);
    } catch (err: any) {
      log.error('agent-remote', `Local spawn failed: ${err.message}`);
      return null;
    }
  }

  if (connection.type === 'ssh') {
    const shellPrefix = initScript
      ? `eval '${initScript.replace(/'/g, "'\\''")}' >/dev/null 2>&1; `
      : '';
    // Idle-shutdown watchdog — ssh ONLY (the remote host is not fate-shared with
    // the client, so it keeps burning resources while the laptop sleeps). Other
    // transports suspend together → never pass it. Default 5min; `0` keeps it
    // alive. See connection-health#2.
    const idleMin = connection.idleShutdownMinutes ?? 5;
    const idleArg = idleMin > 0 ? ` --idle-shutdown-min=${idleMin}` : '';
    // Project env after initScript (so it wins) and before exec, PATH-merged
    // against the target's own $PATH. See buildEnvExportPrefix.
    const envPrefix = buildEnvExportPrefix(projectEnv);
    const cmd = `${shellPrefix}${envPrefix}${testEnv}exec ${nodeBin} ${indexPath}${idleArg}`;
    const args = [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=/tmp/shelf-ssh-${connection.host}-${connection.port}-${connection.user}`,
      '-o', 'ControlPersist=600',
      '-p', String(connection.port),
      `${connection.user}@${connection.host}`,
      cmd,
    ];
    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    return wrapProcess(proc, onTaskEvent, onServerTurn, onHealth, onQueue, onSkillsReloaded, onSessionEvent, projectId);
  }

  if (connection.type === 'docker') {
    const cmd = `${buildEnvExportPrefix(projectEnv)}${testEnv}exec ${nodeBin} ${indexPath}`;
    const proc = spawn('docker', ['exec', '-i', connection.container, 'sh', '-c', cmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return wrapProcess(proc, onTaskEvent, onServerTurn, onHealth, onQueue, onSkillsReloaded, onSessionEvent, projectId);
  }

  if (connection.type === 'wsl') {
    const proc = spawn('wsl.exe', ['-d', connection.distro, '--', 'sh', '-lc', `${buildEnvExportPrefix(projectEnv)}${testEnv}exec ${nodeBin} ${indexPath}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return wrapProcess(proc, onTaskEvent, onServerTurn, onHealth, onQueue, onSkillsReloaded, onSessionEvent, projectId);
  }

  return null;
}

// Heartbeat send interval. Env override (ms) lets E2E drive the lease/health
// loop fast without waiting a real minute; prod uses the §5.9 default (1m).
const HEARTBEAT_INTERVAL_MS = Number(process.env.SHELF_HEARTBEAT_INTERVAL_MS) || DEFAULT_HEALTH_THRESHOLDS.intervalMs;
// Grace for agent-server to run its async normal-closure shutdown (reap detached
// tasks → dispose → self-exit) before we force-kill. Longer than the agent-server
// reap timeout (REAP_TIMEOUT_MS) so it normally exits on its own first.
const SHUTDOWN_GRACE_MS = 3000;

// ── Dispatch-layering (group D3): shared per-host dispatcher path ────────────
// DEFAULT ON. Flipped after E2E + real-dev verification on the LOCAL transport
// with BOTH providers (Copilot + Claude) across all robustness paths (reconnect,
// hung-detection, close/reopen, dispatcher-death recovery). `SHELF_USE_DISPATCHER=0`
// is the escape hatch back to the per-tab path (spawnAgentServer/wrapProcess), kept
// until a later cleanup removes it. CAVEAT: ssh/docker/wsl transports have NOT yet
// been exercised on this path (E2E is fake+local) — the `=0` fallback is the safety
// net if a remote-transport issue surfaces. See the feature note.
const USE_DISPATCHER = process.env.SHELF_USE_DISPATCHER !== '0';

/** Per-transport connection identity — the dispatcher scope key (#3). NOT
 *  "the ControlPath" (that's ssh-unix only). */
function dispatcherKeyFor(c: Connection): string {
  switch (c.type) {
    case 'ssh': return `ssh:${c.host}:${c.port}:${c.user}`;
    case 'docker': return `docker:${c.container}`;
    case 'wsl': return `wsl:${c.distro}`;
    case 'local': return 'local';
    default: return JSON.stringify(c);
  }
}

// Shared per-host dispatcher connections. Ref-counted: the last session's close
// fires onEmpty → arm an idle-teardown GRACE window; a reopen within it reuses the
// warm dispatcher + its model cache (F-b, ControlPersist-style). 120s << the 24h
// cleanup-reclaim threshold, so no dispatcher lease-touch is needed.
interface DispEntry { conn: DispatcherConnection; grace?: NodeJS.Timeout; }
const dispatchers = new Map<string, DispEntry>();
const DISPATCHER_GRACE_MS = Number(process.env.SHELF_DISPATCHER_GRACE_MS) || 120_000;

/** Adapt a spawned child process to the DispatcherProc the connection drives. */
function childToDispatcherProc(child: ChildProcess): DispatcherProc {
  let buf = '';
  return {
    writeLine: (line) => { child.stdin?.write(line + '\n'); },
    onLine: (cb) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) cb(l);
      });
    },
    onExit: (cb) => { child.on('exit', (code) => cb(code)); },
    kill: () => { child.stdin?.end(); child.kill(); },
  };
}

/** Spawn the deployed bundle in `--role=dispatcher` over the transport. Mirrors
 *  spawnAgentServer's transport branches (kept separate so the per-tab path stays
 *  byte-untouched); the dispatcher gets the ssh idle-shutdown watchdog (it owns
 *  it now) while the exec procs it spawns do NOT (#8). */
export function spawnDispatcherProc(connection: Connection, cwd: string, deploy: DeployResult, initScript?: string): ChildProcess | null {
  const { nodeBin, indexPath } = deploy;
  const testEnv = process.env.SHELF_TEST_MODE ? `SHELF_TEST_MODE=${process.env.SHELF_TEST_MODE} ` : '';
  if (connection.type === 'local') {
    // Route through spawnLocalNode so ELECTRON_RUN_AS_NODE=1 is applied — without
    // it, spawning process.execPath (nodeBin) boots a SECOND Electron window
    // instead of the dispatcher (regression; see spawnLocalNode).
    return spawnLocalNode(nodeBin, [indexPath, '--role=dispatcher'], cwd);
  }
  if (connection.type === 'ssh') {
    const shellPrefix = initScript ? `eval '${initScript.replace(/'/g, "'\\''")}' >/dev/null 2>&1; ` : '';
    const idleMin = connection.idleShutdownMinutes ?? 5;
    const idleArg = idleMin > 0 ? ` --idle-shutdown-min=${idleMin}` : '';
    const cmd = `${shellPrefix}${testEnv}exec ${nodeBin} ${indexPath} --role=dispatcher${idleArg}`;
    return spawn('ssh', [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=/tmp/shelf-ssh-${connection.host}-${connection.port}-${connection.user}`,
      '-o', 'ControlPersist=600',
      '-p', String(connection.port),
      `${connection.user}@${connection.host}`,
      cmd,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
  }
  if (connection.type === 'docker') {
    return spawn('docker', ['exec', '-i', connection.container, 'sh', '-c', `${testEnv}exec ${nodeBin} ${indexPath} --role=dispatcher`], { stdio: ['pipe', 'pipe', 'pipe'] });
  }
  if (connection.type === 'wsl') {
    return spawn('wsl.exe', ['-d', connection.distro, '--', 'sh', '-lc', `${testEnv}exec ${nodeBin} ${indexPath} --role=dispatcher`], { stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return null;
}

/** Get (or spawn) the shared dispatcher for this host. */
function ensureDispatcher(connection: Connection, cwd: string, deploy: DeployResult, initScript?: string): DispatcherConnection | null {
  const key = dispatcherKeyFor(connection);
  const existing = dispatchers.get(key);
  if (existing) {
    // Reopen within the grace window → cancel teardown, reuse the warm dispatcher.
    const hadGrace = !!existing.grace;
    if (existing.grace) { clearTimeout(existing.grace); existing.grace = undefined; }
    log.info('agent-remote', `dispatcher: reusing warm connection ${key}${hadGrace ? ' (cancelled idle-teardown grace)' : ''} — model cache stays warm`);
    return existing.conn;
  }
  log.info('agent-remote', `dispatcher: spawning new for ${key}`);
  const child = spawnDispatcherProc(connection, cwd, deploy, initScript);
  if (!child) return null;
  // The dispatcher writes ALL its logs to stderr as `[dispatcher] <level>: <msg>`.
  // Route each line to the matching main log level so a real dispatcher error
  // stands out instead of being buried under info noise (fail-loud). Unstructured
  // lines (e.g. a relayed exec crash trace with no prefix) stay as error.
  child.stderr?.on('data', (c: Buffer) => {
    for (const raw of c.toString().split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = /^\[dispatcher\]\s+(error|warn|info|debug):\s*(.*)$/.exec(line);
      if (m) log[m[1] as 'error' | 'warn' | 'info' | 'debug']('agent-remote', `dispatcher: ${m[2]}`);
      else log.error('agent-remote', `dispatcher stderr: ${line}`);
    }
  });
  child.on('error', (err) => log.error('agent-remote', `dispatcher proc error: ${err.message}`));
  const conn = createDispatcherConnection({
    proc: childToDispatcherProc(child),
    parseRemoteMessage,
    handleAppTool,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    onEmpty: () => {
      const e = dispatchers.get(key);
      if (!e || e.conn !== conn || e.grace) return;
      log.info('agent-remote', `dispatcher: last session closed for ${key} — arming ${DISPATCHER_GRACE_MS}ms idle-teardown grace`);
      e.grace = setTimeout(() => {
        if (dispatchers.get(key)?.conn === conn) {
          log.info('agent-remote', `dispatcher: grace expired for ${key} — tearing down`);
          dispatchers.delete(key); conn.kill();
        }
      }, DISPATCHER_GRACE_MS);
      e.grace.unref?.();
    },
    // Dispatcher proc exited (crash / external kill). EVICT the dead conn from the
    // map — else the next ensureDispatcher "reuses" a corpse and openSession writes
    // to a closed stdin → caps init fails ("Failed to start agent-server") instead
    // of the intended "first reconnect re-spawns a fresh dispatcher".
    onDown: () => {
      const e = dispatchers.get(key);
      if (e?.conn !== conn) return; // a grace teardown / newer conn already replaced us
      if (e.grace) clearTimeout(e.grace);
      dispatchers.delete(key);
      log.warn('agent-remote', `dispatcher for ${key} exited — evicted; next connect spawns fresh`);
    },
  });
  dispatchers.set(key, { conn });
  return conn;
}

function wrapProcess(
  proc: ChildProcess,
  onTaskEvent?: (ev: TaskEvent) => void,
  onServerTurn?: (turnId: string, events: AsyncGenerator<AgentEvent>) => void,
  onHealth?: (health: ConnectionHealth) => void,
  onQueue?: (items: AgentQueueItem[]) => void,
  onSkillsReloaded?: (ok: boolean, error?: string) => void,
  onSessionEvent?: (event: AgentEvent) => void,
  projectId?: string,
): RemoteProcess {
  const dispatcher = createTurnDispatcher(parseRemoteMessage, onTaskEvent, onServerTurn, onQueue, onSkillsReloaded, onSessionEvent);
  let buffer = '';

  // ── Heartbeat: app→agent-server liveness + RTT (see §5.9 / connection-health.ts).
  // The `ping`/`pong` round-trip serves three things off one beat: the version-dir
  // lease (agent-server touches `.heartbeat` on ping), connection-health UX (RTT
  // measured client-side here), and zombie/dead detection. RTT is client-clock
  // only — pong echoes our `seq`, never the server's time.
  const health = new ConnectionHealthTracker(Date.now());
  // Start optimistic: the tracker's grace period reports 'healthy' until the
  // first beat could plausibly be missed. Seeding 'healthy' (not undefined)
  // suppresses a spurious init→healthy transition on the first beat — which
  // otherwise flushed a half-open window ("0/1 acked, no acks") because
  // emitHealth runs synchronously right after the ping is sent, before its pong
  // can round-trip.
  let lastHealthState: ConnectionHealthState = 'healthy';
  let established = false; // log the first successful ack once (startup confirmation)
  let heartbeatSeq = 0;

  // ACK logging — kept LEAN: a rolling in-memory window emits ONE summary line
  // at most once per HB_SUMMARY_MS of healthy beats (so a quiet 8–10h overnight
  // is a handful of lines, not per-beat), while any health-state change (slow /
  // unstable / dead / recovery — e.g. the dead→healthy blip after machine sleep)
  // is logged IMMEDIATELY and starts a fresh window so summaries never straddle
  // an anomaly. Time-driven (not beat-count) so it's robust to the beat interval.
  const HB_SUMMARY_MS = Number(process.env.SHELF_HEARTBEAT_SUMMARY_MS) || 3_600_000; // 60 min
  let win = { sent: 0, acked: 0, rttSum: 0, rttN: 0, rttMin: Infinity, rttMax: 0, since: Date.now() };
  const resetWin = (t: number) => { win = { sent: 0, acked: 0, rttSum: 0, rttN: 0, rttMin: Infinity, rttMax: 0, since: t }; };
  const flushWin = (t: number, tag: string) => {
    if (win.sent === 0) return;
    const rtt = win.rttN
      ? `rtt avg ${Math.round(win.rttSum / win.rttN)}ms (${win.rttMin}–${win.rttMax}ms)`
      : 'no acks';
    log.info('agent-remote', `heartbeat ${tag}: ${win.acked}/${win.sent} acked over ${Math.round((t - win.since) / 1000)}s, ${rtt}`);
    resetWin(t);
  };

  const emitHealth = () => {
    const now = Date.now();
    const h = health.evaluate(now);
    if (h.state !== lastHealthState) {
      flushWin(now, `pre-${h.state}`); // close the current window before the anomaly line
      log.info('agent-remote', `heartbeat health ${lastHealthState}→${h.state}`
        + (h.rttMs != null ? ` rtt=${h.rttMs}ms` : '')
        + (h.lastAckAgoMs != null ? ` lastAckAgo=${Math.round(h.lastAckAgoMs / 1000)}s` : ''));
      lastHealthState = h.state;
      onHealth?.(h);
    }
  };

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    heartbeatSeq += 1;
    health.onSent(heartbeatSeq, now);
    win.sent += 1;
    log.debug('agent-remote', `ping seq=${heartbeatSeq}`);
    try {
      proc.stdin?.write(JSON.stringify({ type: 'ping', seq: heartbeatSeq }) + '\n');
    } catch {
      /* stdin closed — the next evaluate() will surface unstable/dead */
    }
    emitHealth(); // catches missed-beat → unstable/dead between acks (flushes the window on change)
    if (now - win.since >= HB_SUMMARY_MS) flushWin(now, 'ok');
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.(); // never keep the process (or a test) alive for the beat

  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    // A large residual means a wire frame is still mid-arrival (or, after a
    // sleep/network stall, that the stream desynced and no newline is closing
    // the frame). Debug-gated so it's silent unless a wedge repro turns it on.
    if (buffer.length > 16384) {
      log.debug('agent-remote', `stdout buffer residual len=${buffer.length} (frame mid-arrival or desync)`);
    }
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
      // Wire-RX trace (debug; off by default). Pairs with agent-server's wire-tx:
      // an event present in wire-tx but missing here = lost in transit (pipe /
      // sleep stall); present here but never rendered = dropped downstream
      // (dispatcher turnId / renderer). Exclude `log` (already routed below) and
      // `pong` (has its own trace) to keep the signal on turn/content events.
      if (parsed?.type !== 'log' && parsed?.type !== 'pong') {
        const bit = (k: string, v: unknown) => (v == null ? '' : ` ${k}=${String(v).slice(0, 12)}`);
        log.debug('agent-remote', `wire-rx type=${parsed?.type}${bit('turn', parsed?.turnId)}${bit('msgType', parsed?.msgType)}${bit('msgId', parsed?.msgId)}`);
      }
      // Heartbeat ack — transport-level, never reaches the turn dispatcher.
      if (parsed?.type === 'pong') {
        const now = Date.now();
        if (typeof parsed.seq === 'number') {
          health.onAck(parsed.seq, now);
          win.acked += 1;
          const r = health.evaluate(now).rttMs;
          if (typeof r === 'number') {
            win.rttSum += r; win.rttN += 1;
            win.rttMin = Math.min(win.rttMin, r);
            win.rttMax = Math.max(win.rttMax, r);
          }
          if (!established) {
            established = true;
            log.info('agent-remote', `heartbeat established${typeof r === 'number' ? ` rtt=${r}ms` : ''}`);
          }
          // Pong liveness trace (debug). After a wake, whether pongs resume
          // distinguishes "pipe is fine, provider wedged" (pongs flow, no turn
          // events) from "pipe/transport dead" (no pongs) — the first fork to
          // check in a connection-wedge repro.
          log.debug('agent-remote', `pong seq=${parsed.seq}${typeof r === 'number' ? ` rtt=${r}ms` : ''}`);
        }
        emitHealth();
        continue;
      }
      // App-tool bridge — transport-level request/response (like pong), never a
      // turn event. An in-process bridge tool on the agent-server asks main to
      // act on a client-owned resource (skills-store); handle + reply by
      // requestId. See .agent/features/app-level-capabilities.md.
      // Diagnostic log from agent-server (it has no electron to write the file
      // itself). Route to @shared/logger at the carried level — main applies the
      // level filter. See agent-server/server-logger.ts.
      if (parsed?.type === 'log') {
        const raw = parsed.level;
        const level: 'error' | 'warn' | 'info' | 'debug' =
          raw === 'error' ? 'error' : raw === 'warn' ? 'warn' : raw === 'debug' ? 'debug' : 'info';
        const tag = typeof parsed.tag === 'string' ? parsed.tag : 'agent-server';
        log[level](tag, typeof parsed.msg === 'string' ? parsed.msg : String(parsed.msg));
        continue;
      }
      if (parsed?.type === 'app_tool') {
        const requestId = parsed.requestId;
        const op = typeof parsed.op === 'string' ? parsed.op : '';
        const args = (parsed.args && typeof parsed.args === 'object') ? parsed.args : {};
        void handleAppTool(op, args, { projectId }).then((result) => {
          try {
            proc.stdin?.write(JSON.stringify({ type: 'app_tool_result', requestId, ...result }) + '\n');
          } catch { /* stdin closed — bridge tool will time out / get a dead channel */ }
        });
        continue;
      }
      dispatcher.feed(parsed);
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    log.error('agent-remote', 'stderr:', chunk.toString());
  });

  proc.on('exit', (code, signal) => {
    // Transport is gone. Nothing auto-recovers this — the session stays wedged
    // (sends write to a dead stdin, no events flow) until the user manually
    // disconnect→connect (respawn). Warn (not info) so it surfaces at the
    // default log level: an unexpected exit here is the likely culprit behind
    // "agent stuck after sleep". See connection-wedge trace.
    log.warn('agent-remote', `agent-server process exited code=${code} signal=${signal} — transport down until reconnect`);
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
      const w = proc.stdin;
      // Fail-loud on a write to a dead pipe: after a sleep/crash the stdin can be
      // ended/destroyed while the session still thinks it's live, so the send is
      // silently swallowed (a prime "Continue does nothing" suspect). Still write
      // (no behavior change) — but WARN so the drop is visible; else debug-trace
      // the normal send. See connection-wedge trace.
      if (!w || w.writableEnded || w.destroyed) {
        log.warn('agent-remote', `sendLine to non-writable stdin (ended=${w?.writableEnded} destroyed=${w?.destroyed}) type=${(msg as any)?.type}`);
      } else {
        log.debug('agent-remote', `wire-tx-stdin type=${(msg as any)?.type}`);
      }
      w?.write(JSON.stringify(msg) + '\n');
    },
    registerTurn: dispatcher.registerTurn,
    awaitReady: dispatcher.awaitReady,
    onResponse: dispatcher.onResponse,
    kill: () => {
      // Ending stdin triggers agent-server's normal-closure path (rl.on('close') →
      // reap escaped detached tasks → dispose → exit). Because that reap is ASYNC,
      // give it a grace window to self-exit before force-killing — an immediate
      // proc.kill() (SIGTERM) would cut the reap off. unref'd so it can't delay
      // app-quit; the CLI self-exits on its own stdin-EOF regardless.
      clearInterval(heartbeatTimer);
      proc.stdin?.end();
      const forceKill = setTimeout(() => { try { proc.kill(); } catch { /* already exited */ } }, SHUTDOWN_GRACE_MS);
      forceKill.unref();
      proc.once('exit', () => clearTimeout(forceKill));
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
    // renderer opens a new turn block for it. See background-tasks#2.
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

  if (msg.type === 'auth_login_prompt') {
    if (typeof msg.verificationUri !== 'string' || typeof msg.userCode !== 'string') return null;
    return {
      type: 'auth_login_prompt',
      provider: msg.provider ?? 'copilot',
      verificationUri: msg.verificationUri,
      userCode: msg.userCode,
      prefilledUri: typeof msg.prefilledUri === 'string' ? msg.prefilledUri : msg.verificationUri,
    };
  }

  if (msg.type === 'auth_login_done') {
    return {
      type: 'auth_login_done',
      provider: msg.provider ?? 'copilot',
      ok: !!msg.ok,
      cancelled: msg.cancelled === true ? true : undefined,
      error: typeof msg.error === 'string' ? msg.error : undefined,
    };
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
  // Subagent nesting link (reply + fold_*). Passed through so the renderer can
  // nest the message under its outer Agent card. See subagent-display.
  const parent = typeof msg.parentToolUseId === 'string' ? { parentToolUseId: msg.parentToolUseId } : {};
  switch (t) {
    case 'reply':
    case 'note':
    case 'system':
    case 'error':
      return { msgId, type: t, content: msg.content ?? '', ...parent };
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
        ...parent,
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
        ...parent,
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
        ...parent,
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
        ...parent,
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
