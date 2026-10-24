import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { FAKE_PROVIDER } from '@shared/agent-providers';
import { TARGET_PROBE_CMD } from './runtime-target';

process.env.SHELF_USE_DISPATCHER = '0';
const mock = vi.hoisted(() => ({
  home: vi.fn(), exec: vi.fn(), copy: vi.fn(), spawn: vi.fn(), transport: vi.fn(),
  files: vi.fn(), hash: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getAppPath: () => '/app', getPath: () => '/cache', isPackaged: false } }));
vi.mock('fs', () => ({ existsSync: () => true, readFileSync: () => '{"version":"1.0.0"}' }));
vi.mock('child_process', () => ({
  execSync: () => { throw new Error('agent-owned transport bypass'); },
  execFileSync: () => { throw new Error('agent-owned transport bypass'); },
  spawn: () => { throw new Error('agent-owned process bypass'); },
}));
vi.mock('../connector', () => ({ createConnector: () => ({ resolveHomePath: mock.home, exec: mock.exec, copyFile: mock.copy, spawnProcess: mock.spawn }) }));
vi.mock('../connector/transport', () => ({
  transportPutDir: mock.transport,
  composeRemotePath: (home: string, rel: string) => `${home}/${rel}`,
}));
vi.mock('../skills-projection', () => ({ skillsSourceRoot: () => '/skills', listSkillFilesRel: mock.files, hashSkillsTree: mock.hash }));
vi.mock('../mcp-remote', () => ({ syncMcpForConnection: vi.fn() }));
vi.mock('../app-instance-id', () => ({ getAppInstanceId: () => 'app-id' }));
vi.mock('../project-env', () => ({ resolveProjectEnv: () => ({ PROJECT_MARKER: 'session' }) }));
vi.mock('./runtime-cache', () => ({ ensureNodeCached: async () => '/cache/node', ensureClaudeCached: vi.fn(), ensureCopilotCached: vi.fn(), ensureCodexNativeCached: vi.fn() }));

const connections = [
  { type: 'ssh' as const, host: 'host', port: 2222, user: 'user' },
  { type: 'docker' as const, container: 'container' },
  { type: 'wsl' as const, distro: 'Ubuntu' },
];

function child() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn(), write: vi.fn((line: string) => {
    const message = JSON.parse(line);
    if (message.type === 'get_capabilities') queueMicrotask(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'capabilities', requestId: message.requestId }) + '\n')));
  }) };
  proc.kill = vi.fn();
  setTimeout(() => proc.stdout.emit('data', Buffer.from('{"type":"ready"}\n')), 0);
  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.home.mockResolvedValue('/home/target');
  mock.exec.mockImplementation(async (_cwd, command) => ({ stdout: command === TARGET_PROBE_CMD ? 'aarch64\n/lib/ld-linux-aarch64.so.1' : '', stderr: '' }));
  mock.copy.mockResolvedValue(undefined);
  mock.spawn.mockImplementation(child);
  mock.files.mockReturnValue([]); mock.hash.mockReturnValue('hash');
});

describe.each(connections)('$type deploy through connector', (connection) => {
  it('stops before target writes when authoritative home lookup fails', async () => {
    mock.home.mockRejectedValue(new Error('home query failed'));
    const { createRemoteBackend } = await import('./remote');
    const backend = createRemoteBackend(connection, undefined, FAKE_PROVIDER);
    await expect(backend.getCapabilities!('/tmp')).rejects.toThrow('home query failed');
    expect(mock.copy).not.toHaveBeenCalled();
    expect(mock.exec).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
    backend.dispose();
  });

  it('deploys base runtime and starts the direct process without agent-owned transport', async () => {
    const { createRemoteBackend } = await import('./remote');
    const backend = createRemoteBackend(connection, undefined, FAKE_PROVIDER);
    await backend.getCapabilities!('/tmp');
    expect(mock.copy.mock.calls.map((call) => call[1])).toEqual([
      '/home/target/.shelf/agent-server/1.0.0/node', '/home/target/.shelf/agent-server/1.0.0/index.mjs',
    ]);
    expect(mock.spawn).toHaveBeenCalledWith(expect.objectContaining({
      executable: '/home/target/.shelf/agent-server/1.0.0/node',
      env: { PROJECT_MARKER: 'session' },
    }));
    backend.dispose();
  });

  it('waits for a failed copy and never writes the completion sentinel', async () => {
    mock.copy.mockRejectedValue(new Error('transfer failed'));
    const { createRemoteBackend } = await import('./remote');
    const backend = createRemoteBackend(connection, undefined, FAKE_PROVIDER);
    await expect(backend.getCapabilities!('/tmp')).rejects.toThrow('transfer failed');
    expect(mock.exec.mock.calls.some(([, cmd]) => cmd.includes('/.deployed'))).toBe(false);
    expect(mock.spawn).not.toHaveBeenCalled();
    backend.dispose();
  });

  it('skips unchanged runtime files when the deployment sentinel exists', async () => {
    mock.exec.mockImplementation(async (_cwd, cmd) => ({ stdout: cmd === TARGET_PROBE_CMD
      ? 'aarch64\n/lib/ld-linux-aarch64.so.1' : cmd.startsWith('ls -a') ? '.deployed\nnode\nindex.mjs\n' : '', stderr: '' }));
    const { createRemoteBackend } = await import('./remote');
    const backend = createRemoteBackend(connection, undefined, FAKE_PROVIDER);
    await backend.getCapabilities!('/tmp');
    expect(mock.copy).not.toHaveBeenCalled();
    backend.dispose();
  });

  it('uses connector exec for out-of-band skills sync and transport for bytes', async () => {
    mock.files.mockReturnValue(['skill/SKILL.md']);
    const { syncSkillsForConnection } = await import('./remote');
    await syncSkillsForConnection(connection);
    expect(mock.home).toHaveBeenCalled();
    expect(mock.transport).toHaveBeenCalledWith(connection, expect.objectContaining({ files: [{ rel: 'skill/SKILL.md', localPath: '/skills/skill/SKILL.md' }] }));
    expect(mock.exec.mock.calls.at(-1)![1]).toContain('.synced');
    expect(mock.copy).not.toHaveBeenCalled();
  });

  it('starts the dispatcher through the same connector process operation', async () => {
    const { spawnDispatcherProc } = await import('./remote');
    spawnDispatcherProc(connection, '/tmp', { nodeBin: '/node', indexPath: '/index.mjs' });
    expect(mock.spawn).toHaveBeenCalledWith(expect.objectContaining({ executable: '/node', args: expect.arrayContaining(['/index.mjs', '--role=dispatcher']) }));
  });
});
