import { log } from '@shared/logger';
import type { Connection, AgentProvider, ProviderModel } from '@shared/types';
import type { AgentBackend, AgentEvent, AgentQueryOptions } from './types';
import { ChildProcess, spawn, execSync } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getShellEnv } from '../connector/shell-env';

interface RemoteProcess {
  sendLine: (msg: object) => void;
  onLine: (callback: (line: string) => void) => void;
  onPermissionRequest: (handler: (toolUseId: string, toolName: string, input: Record<string, unknown>) => void) => void;
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
  let currentModel: string | null = null;
  let currentEffort: string | null = null;
  let currentPermissionMode: string | null = null;

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
      const ready = await waitForReady(remoteProc);
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

      const userCallback = opts?.canUseTool;
      proc.onPermissionRequest(async (toolUseId, toolName, input) => {
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
      });

      proc.sendLine({
        type: 'send',
        provider,
        prompt,
        cwd,
        sessionId,
        resume: opts?.resume,
        permissionMode: currentPermissionMode ?? opts?.permissionMode,
        model: currentModel ?? undefined,
        effort: currentEffort ?? undefined,
        images: opts?.images,
      });

      yield* streamRemoteEvents(proc);
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

    async getCapabilities(cwd: string, customModels?: ProviderModel[]) {
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
        proc.sendLine({ type: 'get_capabilities', provider, cwd, sessionId, customModels, requestId });
      });
    },

    setModel(model: string) {
      currentModel = model || null;
    },

    setEffort(effort: string) {
      currentEffort = effort || null;
    },

    setPermissionMode(mode: string) {
      currentPermissionMode = mode || null;
    },

    async handleSlashCommand(cmd: string, args: string, cwd?: string) {
      const proc = await ensureProcReady(cwd ?? '');
      if (!proc) return { type: 'error' as const, message: 'Backend not ready' };
      const requestId = `slash-${Date.now()}`;
      return new Promise<import('./types').SlashResult>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ type: 'error', message: 'Timeout waiting for slash command response' });
        }, 30000);
        proc.onResponse(requestId, 'slash_result', (payload) => {
          clearTimeout(timeout);
          resolve(payload.result ?? { type: 'pass-through' });
        });
        proc.sendLine({ type: 'slash_command', provider, cmd, args, requestId });
      });
    },
  };
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

  throw new Error(`Unsupported connection type for deploy: ${connection.type}`);
}

async function spawnAgentServer(
  connection: Connection,
  cwd: string,
  deployedPath: string,
  initScript?: string,
): Promise<RemoteProcess | null> {
  if (connection.type === 'local') {
    try {
      const env = getShellEnv();
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

  return null;
}

function wrapProcess(proc: ChildProcess): RemoteProcess {
  let lineHandler: ((line: string) => void) | null = null;
  let permissionHandler: ((toolUseId: string, toolName: string, input: Record<string, unknown>) => void) | null = null;
  const responseHandlers = new Map<string, (payload: any) => void>();
  let buffer = '';

  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type === 'permission_request' && permissionHandler) {
          permissionHandler(parsed.toolUseId, parsed.toolName, parsed.input ?? {});
          continue;
        }
        if (parsed?.type && parsed.requestId) {
          const key = `${parsed.type}:${parsed.requestId}`;
          const handler = responseHandlers.get(key);
          if (handler) {
            responseHandlers.delete(key);
            handler(parsed);
            continue;
          }
        }
      } catch {
        // fall through to lineHandler
      }
      lineHandler?.(trimmed);
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
    onLine: (callback) => {
      lineHandler = callback;
    },
    onPermissionRequest: (handler) => {
      permissionHandler = handler;
    },
    onResponse: (requestId, expectedType, handler) => {
      responseHandlers.set(`${expectedType}:${requestId}`, handler);
    },
    kill: () => {
      proc.stdin?.end();
      proc.kill();
    },
  };
}

function waitForReady(remote: RemoteProcess): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10000);
    remote.onLine((line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          resolve(true);
        }
      } catch {}
    });
  });
}

async function* streamRemoteEvents(remote: RemoteProcess): AsyncGenerator<AgentEvent> {
  const events: AgentEvent[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  remote.onLine((line) => {
    try {
      const msg = JSON.parse(line);
      const event = parseRemoteMessage(msg);
      if (event) {
        events.push(event);
        if (event.type === 'status' && (event as any).payload?.state === 'idle') {
          done = true;
        }
        resolve?.();
      }
    } catch {}
  });

  while (!done) {
    if (events.length > 0) {
      yield events.shift()!;
    } else {
      await new Promise<void>((r) => { resolve = r; });
    }
  }

  while (events.length > 0) {
    yield events.shift()!;
  }
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
        type: msg.streamType ?? 'text',
        content: msg.content ?? '',
      },
    };
  }

  if (msg.type === 'auth_required') {
    return { type: 'auth_required', provider: msg.provider ?? 'copilot' };
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
  switch (t) {
    case 'text':
    case 'thinking':
    case 'intent':
    case 'system':
    case 'error':
    case 'plan':
      return { type: t, content: msg.content ?? '' };
    case 'tool_use': {
      if (!msg.toolUseId || !msg.toolName) return null;
      const out: import('./types').AgentMessage = {
        type: 'tool_use',
        toolUseId: msg.toolUseId,
        toolName: msg.toolName,
        // Provider should always send a string; coerce defensively for
        // backward-compat (older bundle wire might still emit toolInput object).
        input: typeof msg.input === 'string'
          ? msg.input
          : msg.toolInput
            ? JSON.stringify(msg.toolInput)
            : '',
      };
      if (msg.result) out.result = msg.result;
      return out;
    }
    case 'file_edit': {
      if (!msg.toolUseId || !msg.filePath) return null;
      const out: import('./types').AgentMessage = {
        type: 'file_edit',
        toolUseId: msg.toolUseId,
        filePath: msg.filePath,
      };
      if (msg.diff) out.diff = msg.diff;
      if (typeof msg.content === 'string') out.content = msg.content;
      if (msg.result) out.result = msg.result;
      return out;
    }
    default:
      return null;
  }
}
