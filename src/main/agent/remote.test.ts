import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { MEMORY_PROCESS_ROLE, MEMORY_REPORT_STATUS, MEMORY_WIRE_TYPE } from '@shared/process-memory';

// Exercise createRemoteBackend's per-session process path with an injectable
// child process. Dispatcher behavior has its own focused test suite.
process.env.SHELF_USE_DISPATCHER = '0';

// Mock electron
vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/mock/app',
    getPath: () => '/mock/user-data',
    isPackaged: false,
  },
}));

// Mock fs
vi.mock('fs', () => ({
  readFileSync: vi.fn().mockReturnValue('{"version":"1.0.0"}'),
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  ChildProcess: class {},
}));

// Mock logger
const logError = vi.hoisted(() => vi.fn());
vi.mock('@shared/logger', () => ({
  log: { info: vi.fn(), error: logError, warn: vi.fn(), debug: vi.fn(), trace: vi.fn(), flushTrace: vi.fn() },
}));

// Mock shell-env so spawnLocalNode's env is deterministic (no real login-shell
// resolution) and we can assert the merge keeps our flag on top.
vi.mock('../connector/shell-env', () => ({
  getShellEnv: () => ({ PATH: '/usr/bin', SHELL_ENV_MARKER: 'yes' }),
}));

function capabilitiesChild(
  payload: Record<string, unknown>,
  stopResult?: { ok: boolean; error?: string },
) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes: any[] = [];
  child.stdin = {
    writableEnded: false,
    destroyed: false,
    write: vi.fn((line: string) => {
      const message = JSON.parse(line);
      writes.push(message);
      if (message.type === 'get_capabilities') {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(`${JSON.stringify({
            type: 'capabilities',
            requestId: message.requestId,
            ...payload,
          })}\n`));
        });
      }
      if (message.type === 'stop' && stopResult) {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(`${JSON.stringify({
            type: 'stop_result',
            requestId: message.requestId,
            ...stopResult,
          })}\n`));
        });
      }
      return true;
    }),
    end: vi.fn(),
  };
  child.kill = vi.fn();
  return { child, writes };
}

describe('toWslPath', () => {
  it('converts Windows drive paths to WSL mount paths', async () => {
    const { toWslPath } = await import('./remote');
    expect(toWslPath('C:\\Users\\ben\\app\\resources\\agent-server\\1.2.3\\index.mjs'))
      .toBe('/mnt/c/Users/ben/app/resources/agent-server/1.2.3/index.mjs');
  });

  it('handles lowercase drive letters', async () => {
    const { toWslPath } = await import('./remote');
    expect(toWslPath('c:\\foo\\bar')).toBe('/mnt/c/foo/bar');
  });

  it('handles other drive letters', async () => {
    const { toWslPath } = await import('./remote');
    expect(toWslPath('D:\\Program Files\\Shelf')).toBe('/mnt/d/Program Files/Shelf');
  });
});

describe('localNodeExec — local runs on Electron embedded Node (regression)', () => {
  it('uses process.execPath, not a system "node"', async () => {
    const { localNodeExec } = await import('./remote');
    const { nodeBin } = localNodeExec();
    // Regression: local must not fall back to a bare `node` from PATH — that
    // reintroduced a system-node dependency (Windows users without node).
    expect(nodeBin).not.toBe('node');
    expect(nodeBin).toBe(process.execPath);
  });

  it('sets ELECTRON_RUN_AS_NODE so the app binary behaves as plain Node', async () => {
    const { localNodeExec } = await import('./remote');
    expect(localNodeExec().env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('missing agent-server bundle → clear, surfaced error (regression)', () => {
  // Regression: a stale packaged app (version bumped, app not repackaged) resolves
  // agent-server/<newVersion>/index.mjs which doesn't exist. Before this, the local
  // path had no pre-flight check → node threw MODULE_NOT_FOUND at spawn and the UI
  // showed only the generic "Failed to start agent-server", forcing a logger dive.
  it('agentBundleMissingMessage names the version, the resolved path, and the fix step', async () => {
    const { agentBundleMissingMessage } = await import('./remote');
    const msg = agentBundleMissingMessage('/x/agent-server/9.9.9/index.mjs');
    expect(msg).toContain('/x/agent-server/9.9.9/index.mjs');
    expect(msg).toContain('1.0.0'); // version from the mocked package.json
    expect(msg).toContain('node agent-server/build.mjs'); // isPackaged:false in the mock
  });

  it('local getCapabilities surfaces the bundle-missing cause, not the generic error', async () => {
    // First existsSync call in the local deploy path is the bundle pre-flight → false.
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    const { createRemoteBackend } = await import('./remote');
    const backend = createRemoteBackend({ type: 'local' } as any);
    await expect(backend.getCapabilities!('/tmp')).rejects.toThrow(/bundle not found/);
  });
});

describe('local process.execPath spawns carry ELECTRON_RUN_AS_NODE (regression: no 2nd window)', () => {
  // A local spawn of process.execPath WITHOUT ELECTRON_RUN_AS_NODE=1 boots a full
  // second Electron app window instead of a plain-Node child. The dispatcher path
  // once forgot the flag; these guard both local spawn sites via the shared
  // spawnLocalNode choke point.
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockReturnValue({ pid: 123 } as any);
  });

  it('spawnLocalNode always sets the flag and keeps the login-shell env', async () => {
    const { spawnLocalNode } = await import('./remote');
    spawnLocalNode(process.execPath, ['/bundle/index.mjs'], '/work');
    expect(spawn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = vi.mocked(spawn).mock.calls[0] as any;
    expect(bin).toBe(process.execPath);
    expect(args).toEqual(['/bundle/index.mjs']);
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
    // the flag is merged ON TOP of the login-shell env, not instead of it
    expect(opts.env.SHELL_ENV_MARKER).toBe('yes');
    expect(opts.cwd).toBe('/work');
  });

  it('spawnDispatcherProc local routes through the flagged spawn (THE regression)', async () => {
    const { spawnDispatcherProc } = await import('./remote');
    spawnDispatcherProc(
      { type: 'local' } as any,
      '/work',
      { nodeBin: process.execPath, indexPath: '/bundle/index.mjs' } as any,
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = vi.mocked(spawn).mock.calls[0] as any;
    expect(bin).toBe(process.execPath);
    expect(args).toEqual(['/bundle/index.mjs', '--role=dispatcher']);
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('sshDeployOptStrings — ssh -p vs scp -P (regression)', () => {
  // Regression: the deploy reused one opts string with `-p <port>` for BOTH ssh
  // and scp. scp's port flag is `-P` (capital) — `-p` means preserve-times, so
  // scp swallowed the port as a source operand ("scp: stat local 2222: No such
  // file") → ssh agent deploy broke on any non-default port (found via a real
  // ssh-container agent-deploy run, which had no automated coverage before).
  it('uses lowercase -p for ssh and uppercase -P for scp', async () => {
    const { sshDeployOptStrings } = await import('./remote');
    const { ssh, scp } = sshDeployOptStrings({ host: 'h', port: 2222, user: 'u' });
    expect(ssh).toContain(`'-p' '2222'`);
    expect(ssh).not.toContain(`'-P'`);
    expect(scp).toContain(`'-P' '2222'`);
    expect(scp).not.toContain(`'-p'`);
    // Both still carry the shared ControlMaster opts.
    for (const s of [ssh, scp]) {
      expect(s).toContain(`'ControlMaster=auto'`);
      expect(s).toContain(`'ControlPath=/tmp/shelf-ssh-h-2222-u'`);
    }
  });
});

describe('remote backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('can be imported without errors', async () => {
    const mod = await import('./remote');
    expect(mod.createRemoteBackend).toBeDefined();
  });

  it('createRemoteBackend returns an AgentBackend interface', async () => {
    const { createRemoteBackend } = await import('./remote');
    const backend = createRemoteBackend({ type: 'local' } as any);
    expect(backend).toHaveProperty('query');
    expect(backend).toHaveProperty('stop');
    expect(backend).toHaveProperty('dispose');
    expect(backend).toHaveProperty('checkAuth');
    // setModel/setEffort/setPermissionMode removed — renderer now passes
    // prefs in each AGENT_SEND payload; orchestrator on the agent-server
    // side drives diff detection and calls provider.setX as needed.
  });

  it('waits for a request-correlated stop confirmation', async () => {
    const { child, writes } = capabilitiesChild({}, { ok: true });
    vi.mocked(spawn).mockImplementationOnce(() => {
      setTimeout(() => child.stdout.emit('data', Buffer.from('{"type":"ready"}\n')), 0);
      return child;
    });
    const { createRemoteBackend } = await import('./remote');
    const backend = createRemoteBackend({ type: 'local' } as any);
    await backend.checkAuth('/tmp');

    await expect(backend.stop()).resolves.toBeUndefined();
    expect(writes.find((message) => message.type === 'stop')).toEqual({
      type: 'stop',
      requestId: expect.any(String),
    });
    backend.dispose();
  });

  it('rejects a failed stop confirmation', async () => {
    const { child } = capabilitiesChild({}, { ok: false, error: 'expected cancelled, received end_turn' });
    vi.mocked(spawn).mockImplementationOnce(() => {
      setTimeout(() => child.stdout.emit('data', Buffer.from('{"type":"ready"}\n')), 0);
      return child;
    });
    const { createRemoteBackend } = await import('./remote');
    const backend = createRemoteBackend({ type: 'local' } as any);
    await backend.checkAuth('/tmp');

    await expect(backend.stop()).rejects.toThrow('expected cancelled, received end_turn');
    backend.dispose();
  });

  it('checkAuth emits no init phase when process setup fails', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    const { createRemoteBackend } = await import('./remote');
    const onPhase = vi.fn();
    const backend = createRemoteBackend(
      { type: 'local' } as any,
      undefined,
      undefined,
      'auth-probe-failure',
      onPhase,
    );
    const result = await backend.checkAuth('/tmp');
    expect(result).toBeNull();
    expect(onPhase).not.toHaveBeenCalled();
  });

  it('checkAuth keeps fresh capabilities and stays phase-silent during process setup', async () => {
    const freshCaps = {
      models: [{ value: 'fresh-model', displayName: 'Fresh model' }],
      permissionModes: [{ value: 'default', displayName: 'ask' }],
      effortLevels: [],
      slashCommands: [],
      currentModel: 'fresh-model',
      authRequired: false,
    };
    const { child, writes } = capabilitiesChild(freshCaps);
    vi.mocked(spawn).mockImplementationOnce(() => {
      setTimeout(() => child.stdout.emit('data', Buffer.from('{"type":"ready"}\n')), 0);
      return child;
    });
    const { createRemoteBackend } = await import('./remote');
    const onPhase = vi.fn();
    const backend = createRemoteBackend(
      { type: 'local' } as any,
      undefined,
      undefined,
      'auth-probe-success',
      onPhase,
    );

    const result = await backend.checkAuth('/tmp', [{ id: 'custom-model' }]);

    expect(result).toMatchObject(freshCaps);
    expect(onPhase).not.toHaveBeenCalled();
    expect(writes.find((message) => message.type === 'get_capabilities')).toMatchObject({
      customModels: [{ id: 'custom-model' }],
    });
    backend.dispose();
  });

  it('dispose does not throw when no process exists', async () => {
    const { createRemoteBackend } = await import('./remote');
    const backend = createRemoteBackend({ type: 'local' } as any);
    expect(() => backend.dispose()).not.toThrow();
  });

});

describe('direct exec memory routing', () => {
  it('delivers a validated report while active and rejects late output after kill', async () => {
    const { child } = capabilitiesChild({});
    const onMemoryUsage = vi.fn();
    const { wrapProcess } = await import('./remote');
    const remote = wrapProcess(
      child,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onMemoryUsage,
    );
    const report = {
      type: MEMORY_WIRE_TYPE.USAGE,
      status: MEMORY_REPORT_STATUS.OK,
      sampledAt: '2026-08-05T00:00:00.000Z',
      rows: [{ pid: 10, ppid: 1, memoryKiB: 100, role: MEMORY_PROCESS_ROLE.EXEC }],
    };

    child.stdout.emit('data', Buffer.from(`${JSON.stringify(report)}\n`));
    expect(onMemoryUsage).toHaveBeenCalledWith(report);

    remote.kill();
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(report)}\n`));
    expect(onMemoryUsage).toHaveBeenCalledTimes(1);
  });

  it('logs an error instead of silently dropping a report without a sink', async () => {
    logError.mockClear();
    const { child } = capabilitiesChild({});
    const { wrapProcess } = await import('./remote');
    const remote = wrapProcess(child);
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: MEMORY_WIRE_TYPE.USAGE,
      status: MEMORY_REPORT_STATUS.OK,
      sampledAt: '2026-08-05T00:00:00.000Z',
      rows: [{ pid: 10, ppid: 1, memoryKiB: 100, role: MEMORY_PROCESS_ROLE.EXEC }],
    })}\n`));

    expect(logError).toHaveBeenCalledWith(
      'agent-remote',
      'direct memory report has no registered sink — dropped',
    );
    remote.kill();
  });

  it('fans one main round request to every live direct exec', async () => {
    const first = capabilitiesChild({});
    const second = capabilitiesChild({});
    const { requestAllAgentMemoryUsage, wrapProcess } = await import('./remote');
    const firstRemote = wrapProcess(first.child);
    const secondRemote = wrapProcess(second.child);

    requestAllAgentMemoryUsage();

    expect(first.writes).toContainEqual({ type: MEMORY_WIRE_TYPE.GET_USAGE });
    expect(second.writes).toContainEqual({ type: MEMORY_WIRE_TYPE.GET_USAGE });
    firstRemote.kill();
    secondRemote.kill();
  });

  it('continues the round after one direct request write fails', async () => {
    logError.mockClear();
    const first = capabilitiesChild({});
    const second = capabilitiesChild({});
    first.child.stdin.write.mockImplementation((line: string) => {
      const message = JSON.parse(line);
      if (message.type === MEMORY_WIRE_TYPE.GET_USAGE) throw new Error('closed pipe');
      return true;
    });
    const { requestAllAgentMemoryUsage, wrapProcess } = await import('./remote');
    const firstRemote = wrapProcess(first.child);
    const secondRemote = wrapProcess(second.child);

    expect(() => requestAllAgentMemoryUsage()).not.toThrow();
    expect(second.writes).toContainEqual({ type: MEMORY_WIRE_TYPE.GET_USAGE });
    expect(logError).toHaveBeenCalledWith(
      'agent-remote',
      expect.stringContaining('memory request failed for direct exec: closed pipe'),
    );
    firstRemote.kill();
    secondRemote.kill();
  });
});

describe('parseRemoteMessage — mid-execution capabilities', () => {
  // Regression: mid-execution capabilities (from /model slash or provider model
  // promotion) were dropped because parseRemoteMessage had no 'capabilities'
  // case, so the status bar never reflected a mid-session model change.
  it('maps a capabilities wire message to a capabilities AgentEvent', async () => {
    const { parseRemoteMessage } = await import('./remote');
    const event = parseRemoteMessage({
      type: 'capabilities',
      executionId: 'e-1',
      models: [{ value: 'default', displayName: 'Default' }],
      permissionModes: [],
      effortLevels: [],
      slashCommands: [],
      currentModel: 'claude-opus-4-8',
      currentEffort: 'high',
      currentPermissionMode: 'plan',
    });
    expect(event).toEqual({
      type: 'capabilities',
      caps: {
        models: [{ value: 'default', displayName: 'Default' }],
        permissionModes: [],
        permissionControl: { strategy: 'shelf' },
        effortLevels: [],
        slashCommands: [],
        authMethod: undefined,
        currentModel: 'claude-opus-4-8',
        currentEffort: 'high',
        currentPermissionMode: 'plan',
        authRequired: undefined,
      },
    });
  });

  it('defaults missing capability arrays to empty', async () => {
    const { parseRemoteMessage } = await import('./remote');
    const event = parseRemoteMessage({ type: 'capabilities', currentModel: 'sonnet' });
    expect(event).toMatchObject({
      type: 'capabilities',
      caps: {
        models: [],
        permissionModes: [],
        effortLevels: [],
        slashCommands: [],
        permissionControl: { strategy: 'shelf' },
        currentModel: 'sonnet',
      },
    });
  });

  it('preserves provider-native mode and permission descriptors as independent controls', async () => {
    const { parseRemoteMessage } = await import('./remote');
    const permissionControl = {
      strategy: 'native',
      mode: {
        label: 'Mode',
        currentValue: 'agent',
        options: [
          { value: 'agent', displayName: 'Agent' },
          { value: 'plan', displayName: 'Plan' },
        ],
      },
      permission: {
        label: 'Allow all',
        currentValue: 'off',
        options: [
          { value: 'off', displayName: 'Off' },
          { value: 'on', displayName: 'On' },
        ],
      },
    };

    expect(parseRemoteMessage({
      type: 'capabilities',
      models: [],
      permissionModes: [],
      effortLevels: [],
      slashCommands: [],
      permissionControl,
    })).toMatchObject({
      type: 'capabilities',
      caps: { permissionControl },
    });
  });
});
