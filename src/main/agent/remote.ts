import { log } from '@shared/logger';
import { createConnector } from '../connector';
import type { Connection } from '@shared/types';
import type { AgentBackend, AgentEvent, AgentQueryOptions } from './types';
import type { Connector } from '../connector/types';
import { ensureRemoteDeploy } from './deploy';
import { ChildProcess, spawn } from 'child_process';

interface RemoteProcess {
  proc: ChildProcess;
  sendLine: (msg: object) => void;
  onLine: (callback: (line: string) => void) => void;
  onPermissionRequest: (handler: (toolUseId: string, toolName: string, input: Record<string, unknown>) => void) => void;
  kill: () => void;
}

export function createRemoteBackend(connection: Connection, initScript?: string, provider: 'claude' | 'copilot' | 'gemini' = 'claude'): AgentBackend {
  let remoteProc: RemoteProcess | null = null;
  let lineCallback: ((line: string) => void) | null = null;
  let deployed = false;
  let remotePath = '';
  let currentModel: string | null = null;
  let currentEffort: string | null = null;

  return {
    async *query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent> {
      if (!deployed) {
        const result = await ensureRemoteDeploy(connection, cwd, initScript);
        if ('error' in result) {
          yield { type: 'error', error: result.error };
          return;
        }
        remotePath = result.remotePath;
        deployed = true;
      }

      if (!remoteProc) {
        const proc = await spawnRemoteServer(connection, cwd, remotePath, initScript);
        if (!proc) {
          yield { type: 'error', error: 'Failed to spawn remote agent-server' };
          return;
        }
        remoteProc = proc;

        const ready = await waitForReady(remoteProc);
        if (!ready) {
          yield { type: 'error', error: 'Remote agent-server did not respond' };
          remoteProc.kill();
          remoteProc = null;
          return;
        }
      }

      // Hook permission requests from the remote into the local canUseTool
      // callback, then send the decision back over stdin.
      const userCallback = opts?.canUseTool;
      remoteProc.onPermissionRequest(async (toolUseId, toolName, input) => {
        if (!userCallback) {
          remoteProc?.sendLine({ type: 'resolve_permission', toolUseId, allow: true });
          return;
        }
        const result = await userCallback(toolUseId, toolName, input);
        remoteProc?.sendLine({
          type: 'resolve_permission',
          toolUseId,
          allow: result.behavior === 'allow',
          message: result.behavior === 'deny' ? result.message : undefined,
        });
      });

      remoteProc.sendLine({
        type: 'send',
        provider,
        prompt,
        cwd,
        resume: opts?.resume,
        permissionMode: opts?.permissionMode,
        model: currentModel ?? undefined,
        effort: currentEffort ?? undefined,
        images: opts?.images,
      });

      yield* streamRemoteEvents(remoteProc);
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

    setModel(model: string) {
      currentModel = model || null;
    },

    setEffort(effort: string) {
      currentEffort = effort || null;
    },
  };
}

async function spawnRemoteServer(connection: Connection, cwd: string, remotePath: string, initScript?: string): Promise<RemoteProcess | null> {
  const connector = createConnector(connection);

  const shellPrefix = initScript
    ? `eval '${initScript.replace(/'/g, "'\\''")}' >/dev/null 2>&1; `
    : '';

  const cmd = `${shellPrefix}exec node ${remotePath}/index.js`;

  let args: string[];
  if (connection.type === 'ssh') {
    args = [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=/tmp/shelf-ssh-${connection.host}-${connection.port}-${connection.user}`,
      '-o', 'ControlPersist=600',
      '-p', String(connection.port),
      `${connection.user}@${connection.host}`,
      cmd,
    ];
    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    return wrapProcess(proc);
  } else if (connection.type === 'docker') {
    const proc = spawn('docker', ['exec', '-i', connection.container, 'sh', '-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    return wrapProcess(proc);
  }

  return null;
}

function wrapProcess(proc: ChildProcess): RemoteProcess {
  let lineHandler: ((line: string) => void) | null = null;
  let permissionHandler: ((toolUseId: string, toolName: string, input: Record<string, unknown>) => void) | null = null;
  let buffer = '';

  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Peek for permission_request and dispatch to the permission handler
      // before passing to the generic line handler; avoids mixing it into the
      // AgentEvent stream the caller consumes.
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type === 'permission_request' && permissionHandler) {
          permissionHandler(parsed.toolUseId, parsed.toolName, parsed.input ?? {});
          continue;
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
    log.info('agent-remote', `Remote process exited with code ${code}`);
  });

  return {
    proc,
    sendLine: (msg) => {
      proc.stdin?.write(JSON.stringify(msg) + '\n');
    },
    onLine: (callback) => {
      lineHandler = callback;
    },
    onPermissionRequest: (handler) => {
      permissionHandler = handler;
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
    return {
      type: 'message',
      payload: {
        type: msg.msgType,
        content: msg.content ?? '',
        toolName: msg.toolName,
        toolInput: msg.toolInput,
        toolUseId: msg.toolUseId,
        parentToolUseId: msg.parentToolUseId,
        sessionId: msg.sessionId,
        costUsd: msg.costUsd,
        inputTokens: msg.inputTokens,
        outputTokens: msg.outputTokens,
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
    return { type: 'error', error: msg.error ?? 'Unknown remote error' };
  }

  return null;
}
