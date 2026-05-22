import { log } from '@shared/logger';
import type { Connection, AgentProvider, ProviderModel } from '@shared/types';
import type { AgentBackend, AgentEvent, AgentQueryOptions, PickerResolvePayload } from './types';
import { ChildProcess, spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getShellEnv } from '../connector/shell-env';
import { createTurnDispatcher, type PermissionHandler } from './turn-dispatcher';

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
): AgentBackend {
  let remoteProc: RemoteProcess | null = null;
  let deployed = false;
  let remotePath = '';

  async function ensureProcReady(cwd: string): Promise<RemoteProcess | null> {
    if (!deployed) {
      try {
        remotePath = await deployAgentServer(connection);
      } catch (err: any) {
        log.error('agent-remote', `Deploy failed: ${err.message}`);
        return null;
      }
      deployed = true;
    }
    if (!remoteProc) {
      const proc = await spawnAgentServer(connection, cwd, remotePath, initScript);
      if (!proc) return null;
      remoteProc = proc;
      const ready = await remoteProc.awaitReady();
      if (!ready) {
        remoteProc.kill();
        remoteProc = null;
        return null;
      }
    }
    return remoteProc;
  }

  return {
    async checkAuth() {
      return true;
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
          });
        });
        // `intent` lets agent-server's provider seed session-level closures
        // (e.g. Copilot's currentPermissionMode) before reporting caps back.
        proc.sendLine({ type: 'get_capabilities', provider, cwd, sessionId, customModels, intent, requestId });
      });
    },
  };
}

export function toWslPath(winPath: string): string {
  return winPath
    .replace(/^([A-Za-z]):\\/, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`)
    .replace(/\\/g, '/');
}

function getLocalBundlePath(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf-8'));
  const version = pkg.version;

  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent-server', version, 'index.mjs');
  }
  return path.join(app.getAppPath(), 'dist', 'agent-server', version, 'index.mjs');
}

async function deployAgentServer(connection: Connection): Promise<string> {
  if (connection.type === 'local') {
    return getLocalBundlePath();
  }

  const localPath = getLocalBundlePath();
  if (!fs.existsSync(localPath)) {
    throw new Error(`Agent-server bundle not found at ${localPath}. Run: node agent-server/build.mjs`);
  }

  const remoteDest = '~/.shelf/agent-server/index.mjs';

  if (connection.type === 'ssh') {
    const controlPath = `/tmp/shelf-ssh-${connection.host}-${connection.port}-${connection.user}`;
    const target = `${connection.user}@${connection.host}`;
    const sshOpts = ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', 'ControlPersist=600', '-p', String(connection.port)];

    execSync(`ssh ${sshOpts.map((o) => `'${o}'`).join(' ')} ${target} 'mkdir -p ~/.shelf/agent-server'`, { timeout: 10000 });
    execSync(`scp ${sshOpts.map((o) => `'${o}'`).join(' ')} '${localPath}' ${target}:${remoteDest}`, { timeout: 30000 });
    log.info('agent-remote', `Deployed agent-server to ${target}:${remoteDest}`);
    return remoteDest;
  }

  if (connection.type === 'docker') {
    execSync(`docker exec ${connection.container} mkdir -p /root/.shelf/agent-server`, { timeout: 10000 });
    execSync(`docker cp '${localPath}' ${connection.container}:/root/.shelf/agent-server/index.js`, { timeout: 30000 });
    log.info('agent-remote', `Deployed agent-server to docker:${connection.container}:${remoteDest}`);
    return remoteDest;
  }

  if (connection.type === 'wsl') {
    return toWslPath(getLocalBundlePath());
  }

  throw new Error(`Unsupported connection type for deploy: ${(connection as any).type}`);
}

async function spawnAgentServer(
  connection: Connection,
  cwd: string,
  deployedPath: string,
  initScript?: string,
): Promise<RemoteProcess | null> {
  if (connection.type === 'local') {
    try {
      // Forward SHELF_TEST_MODE from Electron's env so E2E specs can enable
      // the fake provider. getShellEnv() returns a cached login-shell env
      // snapshot that won't pick up test-only flags set at launch time.
      const env: Record<string, string> = { ...getShellEnv() };
      if (process.env.SHELF_TEST_MODE) env.SHELF_TEST_MODE = process.env.SHELF_TEST_MODE;
      log.trace(
        'agent-remote',
        `spawnAgentServer local: cwd=${cwd} deployedPath=${deployedPath} fileExists=${fs.existsSync(deployedPath)} PATH=${env.PATH ?? '<missing>'}`,
      );
      const proc = spawn('node', [deployedPath], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return wrapProcess(proc);
    } catch (err: any) {
      log.error('agent-remote', `Local spawn failed: ${err.message}`);
      return null;
    }
  }

  if (connection.type === 'ssh') {
    const shellPrefix = initScript
      ? `eval '${initScript.replace(/'/g, "'\\''")}' >/dev/null 2>&1; `
      : '';
    const cmd = `${shellPrefix}exec node ${deployedPath}`;
    const args = [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=/tmp/shelf-ssh-${connection.host}-${connection.port}-${connection.user}`,
      '-o', 'ControlPersist=600',
      '-p', String(connection.port),
      `${connection.user}@${connection.host}`,
      cmd,
    ];
    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    return wrapProcess(proc);
  }

  if (connection.type === 'docker') {
    const cmd = `node ${deployedPath}`;
    const proc = spawn('docker', ['exec', '-i', connection.container, 'sh', '-c', cmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return wrapProcess(proc);
  }

  if (connection.type === 'wsl') {
    const proc = spawn('wsl.exe', ['-d', connection.distro, '--', 'node', deployedPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return wrapProcess(proc);
  }

  return null;
}

function wrapProcess(proc: ChildProcess): RemoteProcess {
  const dispatcher = createTurnDispatcher(parseRemoteMessage);
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

function parseRemoteMessage(msg: any): AgentEvent | null {
  if (msg.type === 'message') {
    // Construct discriminated union by msgType — each variant only exposes the
    // fields it actually needs. Provider is responsible for sending matching
    // shape; unknown msgType returns null (caller drops the message).
    const payload = buildAgentMessagePayload(msg);
    if (!payload) return null;
    return { type: 'message', payload };
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
  // msgId is the universal upsert key. For tool messages, msgId is supplied
  // by the provider AND equals toolUseId. For text/thinking/etc., provider
  // mints a fresh `m-...` id. Backward-compat: older agent-server bundle
  // (pre Step 2.1) sent no msgId — fall back to toolUseId (for tools) or
  // synthesize a stable string from content (for non-tool). Synthesized
  // ids are best-effort; they'll never align with stream chunks but at
  // least give renderer a key for the store.
  const msgId: string = msg.msgId ?? msg.toolUseId ?? `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  switch (t) {
    case 'text':
    case 'thinking':
    case 'intent':
    case 'system':
    case 'error':
    case 'plan':
      return { msgId, type: t, content: msg.content ?? '' };
    case 'tool_use': {
      if (!msg.toolUseId || !msg.toolName) return null;
      // Provider should always send a string; coerce defensively for
      // backward-compat (older bundle wire might still emit toolInput object).
      const input: string = typeof msg.input === 'string'
        ? msg.input
        : msg.toolInput
          ? JSON.stringify(msg.toolInput)
          : '';
      return {
        msgId,
        type: 'tool_use',
        toolUseId: msg.toolUseId,
        toolName: msg.toolName,
        input,
        ...(msg.result ? { result: msg.result } : {}),
      };
    }
    case 'file_edit': {
      if (!msg.toolUseId || !msg.filePath) return null;
      return {
        msgId,
        type: 'file_edit',
        toolUseId: msg.toolUseId,
        filePath: msg.filePath,
        ...(msg.diff ? { diff: msg.diff } : {}),
        ...(typeof msg.content === 'string' ? { content: msg.content } : {}),
        ...(msg.result ? { result: msg.result } : {}),
      };
    }
    case 'slash_response': {
      // status guard: only the three known values map cleanly into the renderer
      // union; anything else from a future / mismatched bundle is dropped.
      const status = msg.status;
      if (status !== 'pending' && status !== 'success' && status !== 'error') return null;
      if (typeof msg.slashCmd !== 'string' || typeof msg.content !== 'string') return null;
      return {
        msgId,
        type: 'slash_response',
        slashCmd: msg.slashCmd,
        status,
        content: msg.content,
      };
    }
    default:
      return null;
  }
}
