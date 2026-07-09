import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;
let safeAvailable = true;
let safeBackend: string | undefined;

// Reversible fake safeStorage (os-backed tier): "ENC:" prefix stands in for the
// OS keychain wrap. Real fs + tmp userData for everything else.
vi.mock('electron', () => ({
  app: { getPath: () => tmpDir },
  safeStorage: {
    isEncryptionAvailable: () => safeAvailable,
    getSelectedStorageBackend: () => safeBackend,
    encryptString: (s: string) => Buffer.from('ENC:' + s),
    decryptString: (b: Buffer) => b.toString().replace(/^ENC:/, ''),
  },
}));

const store = await import('./secret-store');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-secret-store-'));
  safeAvailable = true;
  safeBackend = undefined;
  delete process.env.SHELF_MAC_SIGNED;
  store.__resetKeyCacheForTests();
});
afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.SHELF_MAC_SIGNED;
});

describe('secret-store tier selection', () => {
  it('unsigned macOS (default) → local-key even when safeStorage says available', () => {
    // Test host is darwin; without SHELF_MAC_SIGNED the Keychain isn't trusted.
    if (process.platform !== 'darwin') return;
    safeAvailable = true;
    expect(store.getKeyTier()).toBe('local-key');
  });

  it('signed macOS → os-backed', () => {
    if (process.platform !== 'darwin') return;
    process.env.SHELF_MAC_SIGNED = '1';
    safeAvailable = true;
    expect(store.getKeyTier()).toBe('os-backed');
  });

  it('safeStorage unavailable → local-key', () => {
    safeAvailable = false;
    expect(store.getKeyTier()).toBe('local-key');
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
    if (process.platform !== 'darwin') return;
    process.env.SHELF_MAC_SIGNED = '1';
    safeAvailable = true;
    store.setProjectSecret('p1', 'TOKEN', 'secret');
    expect(store.resolveProjectSecrets('p1')).toEqual({ TOKEN: 'secret' });
    // The os-backed key file exists (wrapped), not the local one.
    expect(fs.existsSync(path.join(tmpDir, 'secret-key.enc'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'secret-key.local'))).toBe(false);
  });
});
