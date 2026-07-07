import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import simpleGit, { type SimpleGit } from 'simple-git';
import {
  checkGitAvailable,
  checkRemoteReachable,
  preflight,
  assertPreflight,
  ConfigBackupPreflightError,
} from './preflight';

let root: string;
let bareRemote: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-preflight-'));
  bareRemote = path.join(root, 'remote.git');
  fs.mkdirSync(bareRemote, { recursive: true });
  await simpleGit().raw(['init', '--bare', bareRemote]);
});
afterEach(() => {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
});

/** A SimpleGit stub whose version() rejects — simulates "no git on PATH". */
const noGit = () =>
  ({ version: async () => { throw new Error('spawn git ENOENT'); } } as unknown as SimpleGit);

describe('config-backup preflight', () => {
  it('git present → checkGitAvailable ok with a version string', async () => {
    const res = await checkGitAvailable();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.version).toMatch(/\d+\.\d+/);
  });

  it('git absent → checkGitAvailable fails loud (message names git/PATH)', async () => {
    const res = await checkGitAvailable(noGit());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/git.*PATH/i);
  });

  it('reachable remote → checkRemoteReachable ok (empty bare repo authenticates)', async () => {
    const res = await checkRemoteReachable(bareRemote);
    expect(res.ok).toBe(true);
  });

  it('bogus remote → checkRemoteReachable fails loud with the git error', async () => {
    const res = await checkRemoteReachable(path.join(root, 'does-not-exist.git'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/Could not reach the backup remote/);
  });

  it('preflight returns reason=no-git first when git is missing', async () => {
    const res = await preflight(bareRemote, noGit());
    expect(res).toMatchObject({ ok: false, reason: 'no-git' });
  });

  it('preflight returns reason=remote when git works but remote is bad', async () => {
    const res = await preflight(path.join(root, 'nope.git'));
    expect(res).toMatchObject({ ok: false, reason: 'remote' });
  });

  it('preflight ok for a reachable remote', async () => {
    const res = await preflight(bareRemote);
    expect(res.ok).toBe(true);
  });

  it('assertPreflight throws a typed ConfigBackupPreflightError on failure', async () => {
    await expect(assertPreflight(path.join(root, 'nope.git'))).rejects.toBeInstanceOf(
      ConfigBackupPreflightError,
    );
    await expect(assertPreflight(bareRemote)).resolves.toBeUndefined();
  });
});
