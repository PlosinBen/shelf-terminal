import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';

/**
 * Backup action integration test: real skills/MCP on disk under a mocked
 * <userData>, a real temp bare repo as the remote. Runs runBackup(), then a
 * second "machine" clones + reads the pushed branch to prove exactly the ticked
 * items landed (leak gate: unticked never leaves; snapshot: unticking removes).
 */

let userDataDir: string;

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

const { runBackup } = await import('./backup');
const { saveBinding, thisMachineBranchRef } = await import('./binding-store');
const { createSideCar } = await import('./side-car');

let root: string;
let bareRemote: string;

function seedSkill(name: string, aux?: { rel: string; bytes: Buffer }): void {
  const dir = path.join(userDataDir, 'skills', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`);
  if (aux) fs.writeFileSync(path.join(dir, aux.rel), aux.bytes);
}
function seedMcp(servers: Record<string, unknown>): void {
  fs.writeFileSync(path.join(userDataDir, 'mcp-servers.json'), JSON.stringify(servers, null, 2));
}

/** Clone the bare into a throwaway reader dir and return branch file contents. */
async function readBranch(branch: string): Promise<{ files: string[]; read: (p: string) => Promise<string | null> }> {
  const readerUserData = path.join(root, 'reader-' + Math.abs(hash(branch + fs.readdirSync(root).length)));
  fs.mkdirSync(readerUserData, { recursive: true });
  const prev = userDataDir;
  userDataDir = readerUserData;
  const sc = createSideCar();
  await sc.ensureClone(bareRemote);
  await sc.fetch();
  const ref = `origin/${branch}`;
  const files = await sc.listFilesAtRef(ref);
  userDataDir = prev;
  return { files, read: (p) => sc.readFileAtRef(ref, p) };
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-backup-'));
  bareRemote = path.join(root, 'remote.git');
  fs.mkdirSync(bareRemote, { recursive: true });
  await simpleGit().raw(['init', '--bare', bareRemote]);
  userDataDir = path.join(root, 'machineA');
  fs.mkdirSync(userDataDir, { recursive: true });
});
afterEach(() => {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
});

describe('config-backup runBackup', () => {
  it('not bound → typed not-bound result (never touches git)', async () => {
    const res = await runBackup(['skill:alpha']);
    expect(res).toMatchObject({ ok: false, reason: 'not-bound' });
  });

  it('pushes exactly the ticked items; unticked never leave (leak gate)', async () => {
    seedSkill('alpha', { rel: 'logo.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    seedSkill('beta');
    seedMcp({ fs: { type: 'stdio', command: 'node' }, secret: { type: 'http', url: 'https://x' } });
    saveBinding({ remoteUrl: bareRemote, machineLabel: 'work-mac' });

    const res = await runBackup(['skill:alpha', 'mcp:fs']);
    expect(res).toMatchObject({ ok: true, pushed: true, itemCount: 2 });

    const branch = thisMachineBranchRef();
    const { files, read } = await readBranch(branch);

    // ticked skill (incl. binary aux) + ticked mcp + manifest present
    expect(files).toContain('skills/alpha/SKILL.md');
    expect(files).toContain('skills/alpha/logo.png');
    expect(files).toContain('mcp-servers.json');
    expect(files).toContain('machine.json');

    // unticked skill + unticked server never left the machine
    expect(files.some((f) => f.startsWith('skills/beta/'))).toBe(false);
    const mcpJson = JSON.parse((await read('mcp-servers.json'))!);
    expect(Object.keys(mcpJson)).toEqual(['fs']);
    expect(mcpJson.secret).toBeUndefined();

    const manifest = JSON.parse((await read('machine.json'))!);
    expect(manifest.machineLabel).toBe('work-mac');
    expect(typeof manifest.appInstanceId).toBe('string');
  });

  it('re-backup with no change → pushed:false', async () => {
    seedSkill('alpha');
    saveBinding({ remoteUrl: bareRemote, machineLabel: 'm' });
    expect((await runBackup(['skill:alpha'])).ok).toBe(true);
    const res = await runBackup(['skill:alpha']);
    expect(res).toMatchObject({ ok: true, pushed: false });
  });

  it('snapshot semantics: unticking an item removes it from the branch', async () => {
    seedSkill('alpha');
    seedSkill('beta');
    saveBinding({ remoteUrl: bareRemote, machineLabel: 'm' });

    await runBackup(['skill:alpha', 'skill:beta']);
    const branch = thisMachineBranchRef();
    let snap = await readBranch(branch);
    expect(snap.files.some((f) => f.startsWith('skills/beta/'))).toBe(true);

    // Next backup ticks only alpha → beta must be removed from the branch.
    const res = await runBackup(['skill:alpha']);
    expect(res).toMatchObject({ ok: true, pushed: true });
    snap = await readBranch(branch);
    expect(snap.files.some((f) => f.startsWith('skills/alpha/'))).toBe(true);
    expect(snap.files.some((f) => f.startsWith('skills/beta/'))).toBe(false);
  });
});
