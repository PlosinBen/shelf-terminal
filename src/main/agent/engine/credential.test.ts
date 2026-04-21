import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { createStaticCredentialStore } from './credential';

describe('createStaticCredentialStore', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shelf-cred-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    delete process.env.TEST_PROVIDER_KEY;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.TEST_PROVIDER_KEY;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('returns null when neither env nor file is set', async () => {
    const store = createStaticCredentialStore('testprov', 'TEST_PROVIDER_KEY');
    expect(await store.get()).toBeNull();
  });

  it('env var takes precedence over file', async () => {
    const store = createStaticCredentialStore('testprov', 'TEST_PROVIDER_KEY');
    await store.set('from-file');
    process.env.TEST_PROVIDER_KEY = 'from-env';
    expect(await store.get()).toBe('from-env');
  });

  it('round-trips a key through set/get', async () => {
    const store = createStaticCredentialStore('testprov', 'TEST_PROVIDER_KEY');
    await store.set('secret-123');
    expect(await store.get()).toBe('secret-123');
  });

  it('writes the file with mode 0600', async () => {
    const store = createStaticCredentialStore('testprov', 'TEST_PROVIDER_KEY');
    await store.set('secret-123');
    const stat = await fs.stat(store.filePath());
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('clear removes the file and is idempotent on ENOENT', async () => {
    const store = createStaticCredentialStore('testprov', 'TEST_PROVIDER_KEY');
    await store.set('secret');
    await store.clear();
    expect(await store.get()).toBeNull();
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('ignores malformed JSON and returns null', async () => {
    const store = createStaticCredentialStore('testprov', 'TEST_PROVIDER_KEY');
    await fs.mkdir(path.dirname(store.filePath()), { recursive: true });
    await fs.writeFile(store.filePath(), 'not-json');
    expect(await store.get()).toBeNull();
  });

  it('rejects empty keys on set', async () => {
    const store = createStaticCredentialStore('testprov', 'TEST_PROVIDER_KEY');
    await expect(store.set('')).rejects.toThrow();
  });

  it('different provider ids write to different files', async () => {
    const a = createStaticCredentialStore('prov-a', 'A_KEY');
    const b = createStaticCredentialStore('prov-b', 'B_KEY');
    expect(a.filePath()).not.toBe(b.filePath());
  });
});
