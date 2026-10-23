import { describe, it, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorktreeProbe, PathProbe, powershellCommand } from './worktree-probe';
const exec = promisify(execFile);
describe('target worktree probe', () => {
  it('resolves Git identity, aliases, non-repositories and missing paths on target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'shelf-probe-'));
    const connector = { exec: async (cwd: string, cmd: string) => exec('sh', ['-c', cmd], { cwd }) };
    const probe = new WorktreeProbe(connector, root, false);
    try {
      const repo = path.join(root, "repo ' special\nname");
      await mkdir(repo); await mkdir(path.join(repo, 'sub'));
      await exec('git', ['init', repo]);
      const identity = await probe.identity(repo);
      expect(identity?.checkoutPath).toBe(await realpath(repo));
      expect(await probe.identity(path.join(repo, 'sub'))).toEqual(identity);
      await symlink(repo, path.join(root, 'alias'));
      expect(await probe.identity(path.join(root, 'alias'))).toEqual(identity);
      expect(await probe.path(path.join(root, 'missing', 'nested'))).toBe(PathProbe.MISSING);
      expect(await probe.identity(root)).toBeNull();
      expect(await probe.identity(path.join(root, 'missing'))).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('propagates transport and permission errors instead of reporting missing', async () => {
    const probe = new WorktreeProbe({ exec: vi.fn().mockRejectedValue(new Error('Permission denied')) }, '/base', false);
    await expect(probe.identity('/child')).rejects.toThrow('Permission denied');
  });
  it('encodes Windows scripts without exposing paths to cmd expansion', () => {
    const script = "[IO.File]::GetAttributes('C:\\a%PATH% & b')";
    const command = powershellCommand(script);
    expect(command).not.toContain('%PATH%');
    expect(Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le')).toContain(script);
  });
});
