import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;
let safeAvailable = true;
let safeBackend: string | undefined;
const isEncryptionAvailable = vi.fn(() => safeAvailable);

// Reversible fake safeStorage (os-backed tier): "ENC:" prefix stands in for the
// OS keychain wrap. Real fs + tmp userData for everything else.
vi.mock('electron', () => ({
  app: { getPath: () => tmpDir },
  safeStorage: {
    isEncryptionAvailable,
    getSelectedStorageBackend: () => safeBackend,
    encryptString: (s: string) => Buffer.from('ENC:' + s),
    decryptString: (b: Buffer) => b.toString().replace(/^ENC:/, ''),
  },
}));

const store = await import('./secret-store');

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-secret-store-'));
  safeAvailable = true;
  safeBackend = undefined;
  isEncryptionAvailable.mockClear();
  store.__resetKeyCacheForTests();
});
afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('secret-store tier selection', () => {
  it('macOS → local-key without probing safeStorage', () => {
    safeAvailable = true;
    withPlatform('darwin', () => {
      expect(store.getKeyTier()).toBe('local-key');
      expect(isEncryptionAvailable).not.toHaveBeenCalled();
    });
  });

  it('safeStorage unavailable → local-key', () => {
    safeAvailable = false;
    withPlatform('win32', () => {
      expect(store.getKeyTier()).toBe('local-key');
      expect(isEncryptionAvailable).toHaveBeenCalledOnce();
    });
  });
});

describe('secret-store persistence (local-key tier)', () => {
  it('set → resolve round-trips, and writes a 0600 key + secrets file', () => {
    store.setProjectSecret('p1', 'GH_TOKEN', 'gho_abc');
    expect(store.resolveProjectSecrets('p1')).toEqual({ GH_TOKEN: 'gho_abc' });

    // Master key persisted to the local 0600 file (not the os-backed one).
    const keyFile = path.join(tmpDir, 'secret-key.local');
    expect(fs.existsSync(keyFile)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    }
    // Secrets file exists and does NOT contain the plaintext value.
    const raw = fs.readFileSync(path.join(tmpDir, 'project-secrets.json'), 'utf8');
    expect(raw).not.toContain('gho_abc');
  });

  it('lists secret KEY names without exposing values', () => {
    store.setProjectSecret('p1', 'B_KEY', 'v1');
    store.setProjectSecret('p1', 'A_KEY', 'v2');
    expect(store.listProjectSecretKeys('p1')).toEqual(['A_KEY', 'B_KEY']); // sorted
  });

  it('scopes decryption to the target project only', () => {
    store.setProjectSecret('p1', 'ONE', '1');
    store.setProjectSecret('p2', 'TWO', '2');
    expect(store.resolveProjectSecrets('p1')).toEqual({ ONE: '1' });
    expect(store.resolveProjectSecrets('p2')).toEqual({ TWO: '2' });
  });

  it('rejects a reserved key at set (backstop)', () => {
    expect(() => store.setProjectSecret('p1', 'SHELF_X', 'v')).toThrow(/reserved/);
    expect(() => store.setProjectSecret('p1', 'ELECTRON_RUN_AS_NODE', 'v')).toThrow(/reserved/);
  });

  it('deletes one secret, pruning the project section when empty', () => {
    store.setProjectSecret('p1', 'ONLY', 'v');
    store.deleteProjectSecret('p1', 'ONLY');
    expect(store.resolveProjectSecrets('p1')).toEqual({});
    // Section pruned → project no longer present.
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'project-secrets.json'), 'utf8'));
    expect(data.p1).toBeUndefined();
  });

  it('deleteProjectSecrets prunes the whole project section', () => {
    store.setProjectSecret('p1', 'A', '1');
    store.setProjectSecret('p1', 'B', '2');
    store.deleteProjectSecrets('p1');
    expect(store.listProjectSecretKeys('p1')).toEqual([]);
  });

  it('copyProjectSecrets duplicates a section under a new id, values decryptable', () => {
    store.setProjectSecret('base', 'API_KEY', 'sekret');
    store.setProjectSecret('base', 'TOKEN', 'tok');
    store.copyProjectSecrets('base', 'wt-1');
    expect(store.listProjectSecretKeys('wt-1')).toEqual(['API_KEY', 'TOKEN']);
    // Reused blobs decrypt with the same master key.
    expect(store.resolveProjectSecrets('wt-1')).toEqual({ API_KEY: 'sekret', TOKEN: 'tok' });
    // Independent copy: deleting the source leaves the worktree's secrets intact.
    store.deleteProjectSecrets('base');
    expect(store.resolveProjectSecrets('wt-1')).toEqual({ API_KEY: 'sekret', TOKEN: 'tok' });
  });

  it('copyProjectSecrets is a no-op when the source has none', () => {
    store.copyProjectSecrets('nobody', 'wt-2');
    expect(store.listProjectSecretKeys('wt-2')).toEqual([]);
  });

  it('fail-loud SKIPS a corrupt/undecryptable entry instead of injecting stale/empty', () => {
    store.setProjectSecret('p1', 'GOOD', 'ok');
    // Corrupt one entry directly on disk.
    const file = path.join(tmpDir, 'project-secrets.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.p1.BROKEN = 'v1:notreal:notreal:notreal';
    fs.writeFileSync(file, JSON.stringify(data));
    const resolved = store.resolveProjectSecrets('p1');
    expect(resolved).toEqual({ GOOD: 'ok' }); // BROKEN skipped, GOOD survives
  });
});

describe('secret-store persistence (os-backed tier)', () => {
  it('round-trips via the safeStorage-wrapped master key', () => {
    safeAvailable = true;
    withPlatform('win32', () => {
      store.setProjectSecret('p1', 'TOKEN', 'secret');
      expect(store.resolveProjectSecrets('p1')).toEqual({ TOKEN: 'secret' });
      // The os-backed key file exists (wrapped), not the local one.
      expect(fs.existsSync(path.join(tmpDir, 'secret-key.enc'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'secret-key.local'))).toBe(false);
    });
  });
});
