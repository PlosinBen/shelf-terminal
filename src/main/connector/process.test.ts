import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { execFile, spawn } from 'child_process';
import { SSHUnixConnector } from './ssh/unix';
import { SSHWin32Connector } from './ssh/win32';
import { DockerConnector } from './docker';
import { WSLConnector } from './wsl';
import { LocalUnixConnector } from './local/unix';
import { LocalWin32Connector } from './local/win32';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('child_process', () => ({ execFile: vi.fn(), spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock('../ssh-control', () => ({ getControlPath: () => '/tmp/hashed-master', getKnownHostsPath: () => '/isolated/known_hosts' }));
vi.mock('./shell-env', async (importOriginal) => ({
  ...await importOriginal<typeof import('./shell-env')>(),
  getShellEnv: () => ({ PATH: '/usr/bin', MARKER: 'login-env' }),
}));

const factories = [
  ['ssh/unix', () => new SSHUnixConnector('host', 2222, 'user')],
  ['ssh/win32', () => new SSHWin32Connector('host', 2222, 'user')],
  ['docker', () => new DockerConnector('container')],
  ['wsl', () => new WSLConnector('Ubuntu')],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execFile).mockImplementation((_file: any, _args: any, _opts: any, cb: any) => {
    cb(null, '/actual/home\n', '');
    return {} as any;
  });
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter() as any;
    child.stdin = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  });
});

describe.each(factories)('%s deployment operations', (_name, make) => {
  // Promise: deploy must fail before writing to an invented home. Folder-picker
  // homePath fallbacks do not satisfy this contract; review deploy destinations
  // and caller error propagation before weakening these assertions.
  it('resolves the actual absolute home', async () => {
    await expect(make().resolveHomePath()).resolves.toBe('/actual/home');
  });

  it.each(['', '\n', 'relative/home'])('rejects invalid home %j', async (output) => {
    vi.mocked(execFile).mockImplementation((_file: any, _args: any, _opts: any, cb: any) => {
      cb(null, output, ''); return {} as any;
    });
    await expect(make().resolveHomePath()).rejects.toThrow(/home/i);
  });

  it('reports home query failure instead of guessing a destination', async () => {
    vi.mocked(execFile).mockImplementation((_file: any, _args: any, _opts: any, cb: any) => {
      cb(new Error('connection lost'), '', 'connection lost'); return {} as any;
    });
    await expect(make().resolveHomePath()).rejects.toThrow(/connection lost/);
  });

  it('copies a local file through the native transfer with a large-file timeout', async () => {
    await make().copyFile('/local/payload', '/target/payload');
    expect(execFile).toHaveBeenLastCalledWith(expect.any(String), expect.any(Array),
      expect.objectContaining({ timeout: 180_000 }), expect.any(Function));
  });

  it('returns a process with separate bidirectional pipes, without a PTY', () => {
    const child = make().spawnProcess({ executable: '/runtime/node', args: ['/bundle/index.mjs'] });
    expect(child.stdin).toBeDefined();
    expect(child.stdout).not.toBe(child.stderr);
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }));
  });
});

it('SSH copy and process reuse the authenticated master and isolated known_hosts', async () => {
  const connector = new SSHUnixConnector('host', 2222, 'user');
  await connector.copyFile('/local/file with space', '/target/file with space');
  const [bin, args] = vi.mocked(execFile).mock.calls.at(-1)!;
  expect(bin).toBe('scp');
  expect(args).toEqual(expect.arrayContaining(['-P', '2222', 'ControlPath=/tmp/hashed-master', 'StrictHostKeyChecking=accept-new']));
  expect(args).not.toContain('-p');
  connector.spawnProcess({ executable: '/runtime/node', args: ['/bundle/index.mjs'] });
  expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(expect.arrayContaining([
    '-p', '2222', 'ControlPath=/tmp/hashed-master', 'UserKnownHostsFile="/isolated/known_hosts"',
  ]));
});

it('Windows SSH never requests ControlMaster', () => {
  new SSHWin32Connector('host', 2222, 'user').spawnProcess({ executable: '/node', args: [] });
  expect(JSON.stringify(vi.mocked(spawn).mock.calls)).not.toContain('ControlMaster');
});

it.each([LocalUnixConnector, LocalWin32Connector])('local process preserves required environment on %s', (Ctor) => {
  new Ctor().spawnProcess({ executable: process.execPath, args: ['/bundle/index.mjs'], cwd: '/work',
    env: { ELECTRON_RUN_AS_NODE: '0', EXTRA: 'project' }, requiredEnv: { ELECTRON_RUN_AS_NODE: '1' } });
  expect(spawn).toHaveBeenCalledWith(process.execPath, ['/bundle/index.mjs'], expect.objectContaining({
    cwd: '/work', env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1', EXTRA: 'project' }),
  }));
});

it('remote process quotes arguments, applies init before env, and preserves target PATH', () => {
  new DockerConnector('container').spawnProcess({ executable: '/node with space', args: ["arg'quote"],
    initScript: 'export EXTRA=init', env: { EXTRA: 'project', PATH: '/project/bin' }, requiredEnv: { SHELF_TEST_MODE: '1' } });
  const command = vi.mocked(spawn).mock.calls[0][1]!.at(-1)!;
  expect(command).toContain("'/node with space'");
  expect(command).toContain("'arg'\\''quote'");
  expect(command).toContain('"$PATH"');
  expect(command.indexOf('EXTRA=init')).toBeLessThan(command.indexOf("EXTRA='project'"));
  expect(command).toContain("export SHELF_TEST_MODE='1'");
});

describe('toWslPath', () => {
  it('converts Windows drive paths to WSL mount paths', async () => {
    const { toWslPath } = await import('./process');
    expect(toWslPath('C:\\Users\\ben\\app\\resources\\agent-server\\1.2.3\\index.mjs'))
      .toBe('/mnt/c/Users/ben/app/resources/agent-server/1.2.3/index.mjs');
  });

  it('handles lowercase drive letters', async () => {
    const { toWslPath } = await import('./process');
    expect(toWslPath('c:\\foo\\bar')).toBe('/mnt/c/foo/bar');
  });

  it('handles other drive letters', async () => {
    const { toWslPath } = await import('./process');
    expect(toWslPath('D:\\Program Files\\Shelf')).toBe('/mnt/d/Program Files/Shelf');
  });
});
