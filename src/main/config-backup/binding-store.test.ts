import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BACKUP_BRANCH_PREFIX } from '@shared/config-backup';

let tmpDir: string;

vi.mock('electron', () => ({
  app: { getPath: () => tmpDir },
}));

const { loadBinding, saveBinding, clearBinding, thisMachineBranchRef } = await import('./binding-store');

const bindingFile = () => path.join(tmpDir, 'config-backup.json');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-config-backup-'));
});
afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('config-backup binding store', () => {
  it('unbound machine reads null (no file)', () => {
    expect(loadBinding()).toBeNull();
  });

  it('save then load round-trips remoteUrl + machineLabel', () => {
    saveBinding({ remoteUrl: 'git@github.com:me/backups.git', machineLabel: 'work-mac' });
    expect(loadBinding()).toEqual({ remoteUrl: 'git@github.com:me/backups.git', machineLabel: 'work-mac' });
  });

  it('trims inputs on save', () => {
    saveBinding({ remoteUrl: '  https://x/y.git  ', machineLabel: '  home  ' });
    expect(loadBinding()).toEqual({ remoteUrl: 'https://x/y.git', machineLabel: 'home' });
  });

  it('rejects empty remoteUrl / machineLabel (fail-loud, no half-written binding)', () => {
    expect(() => saveBinding({ remoteUrl: '   ', machineLabel: 'x' })).toThrow(/remoteUrl/);
    expect(() => saveBinding({ remoteUrl: 'x', machineLabel: '  ' })).toThrow(/machineLabel/);
    expect(fs.existsSync(bindingFile())).toBe(false);
  });

  it('corrupt JSON is treated as unbound, not a crash', () => {
    fs.writeFileSync(bindingFile(), '{ not json', 'utf-8');
    expect(loadBinding()).toBeNull();
  });

  it('wrong-shape JSON is treated as unbound', () => {
    fs.writeFileSync(bindingFile(), JSON.stringify({ remoteUrl: 42 }), 'utf-8');
    expect(loadBinding()).toBeNull();
  });

  it('clearBinding removes the file; missing file is a no-op', () => {
    saveBinding({ remoteUrl: 'x', machineLabel: 'y' });
    clearBinding();
    expect(loadBinding()).toBeNull();
    expect(() => clearBinding()).not.toThrow();
  });

  it('branch ref is derived from a stable app-instance-id and is prefixed + stable across calls', () => {
    const ref = thisMachineBranchRef();
    expect(ref.startsWith(BACKUP_BRANCH_PREFIX)).toBe(true);
    expect(thisMachineBranchRef()).toBe(ref); // stable within a machine
  });
});
