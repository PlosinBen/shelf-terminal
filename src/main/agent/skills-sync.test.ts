import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression for the ssh tilde bug (transport-integration): sshOps used
 * `base:'~'`, but syncSkillsToRemote's exec-built control commands embed the base
 * inside DOUBLE quotes (`mkdir -p "<base>/.shelf/..."`), where POSIX sh does NOT
 * expand `~` — so they targeted a literal `$HOME/~/...` junk dir while the files
 * (now via the transport) went to the real absolute home. The fix resolves an
 * absolute `$HOME` for sshOps up front. This test drives syncSkillsForConnection
 * over ssh and asserts the control commands use the ABSOLUTE home, never `~`.
 */

const HOME = '/home/testuser';

// Capture every execSync command string; answer `echo "$HOME"` with an absolute
// home and everything else (cat/.synced, rm/mkdir, printf/.heartbeat) with ''.
const execCalls: string[] = [];
const execSync = vi.fn((cmd: string, _opts?: unknown) => {
  execCalls.push(cmd);
  return cmd.includes('echo "$HOME"') ? `${HOME}\n` : '';
});

vi.mock('child_process', () => ({
  execSync: (cmd: string, opts?: unknown) => execSync(cmd, opts),
  spawn: vi.fn(),
  execFileSync: vi.fn(),
  ChildProcess: class {},
}));
vi.mock('fs', () => ({
  existsSync: () => true,
  readFileSync: vi.fn(() => '{"version":"1.0.0"}'),
  promises: { readFile: vi.fn(async () => Buffer.from('x')) },
}));
vi.mock('electron', () => ({ app: { getPath: () => '/userdata', getAppPath: () => '/app', isPackaged: false } }));
vi.mock('@shared/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn(), flushTrace: vi.fn() },
}));
vi.mock('../app-instance-id', () => ({ getAppInstanceId: () => 'app-xyz' }));
vi.mock('../skills-projection', () => ({
  skillsSourceRoot: () => '/src/skills',
  listSkillFilesRel: () => ['SKILL.md', 'scripts/run.sh'],
  hashSkillsTree: () => 'hash-1',
}));

// Decouple the byte plane: capture transportPutDir, reimplement composeRemotePath.
const transportPutDir = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../connector/transport', () => ({
  transportPutDir: (...args: unknown[]) => transportPutDir(...args),
  composeRemotePath: (base: string, rel: string) => `${base.replace(/\/+$/, '')}/${rel}`,
}));

describe('syncSkillsForConnection (ssh) — absolute home, no tilde', () => {
  beforeEach(() => {
    execCalls.length = 0;
    execSync.mockClear();
    transportPutDir.mockClear();
  });

  it('resolves $HOME and targets the absolute skills dir in every control command', async () => {
    const { syncSkillsForConnection } = await import('./remote');
    await syncSkillsForConnection({ type: 'ssh', host: 'h', port: 22, user: 'testuser' } as any);

    // sshOps resolves the absolute home first.
    expect(execCalls.some((c) => c.includes('echo "$HOME"'))).toBe(true);

    const target = `${HOME}/.shelf/apps/app-xyz/skills`;
    const mkdir = execCalls.find((c) => c.includes('mkdir -p') && c.includes('.shelf/apps'));
    const synced = execCalls.find((c) => c.includes('.synced') && c.includes('printf'));
    expect(mkdir).toBeDefined();
    expect(synced).toBeDefined();
    // Absolute path, NOT a quoted literal `~` (the bug).
    expect(mkdir!).toContain(target);
    expect(synced!).toContain(target);
    for (const c of execCalls) {
      expect(c).not.toContain('"~/'); // no double-quoted tilde anywhere
    }
  });

  it('places skill bytes via the transport (type skill, appId, mapped files)', async () => {
    const { syncSkillsForConnection } = await import('./remote');
    await syncSkillsForConnection({ type: 'ssh', host: 'h', port: 22, user: 'testuser' } as any);

    expect(transportPutDir).toHaveBeenCalledTimes(1);
    const [, args] = transportPutDir.mock.calls[0] as unknown as [unknown, any];
    expect(args.type).toBe('skill');
    expect(args.context).toEqual({ appId: 'app-xyz' });
    expect(args.files).toEqual([
      { rel: 'SKILL.md', localPath: '/src/skills/SKILL.md' },
      { rel: 'scripts/run.sh', localPath: '/src/skills/scripts/run.sh' },
    ]);
  });
});
