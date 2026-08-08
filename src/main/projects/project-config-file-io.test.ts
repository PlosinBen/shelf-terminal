import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProjectConfigFileIo,
  type ProjectConfigFileOperations,
} from './project-config-file-io';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shelf-project-io-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('project config file I/O', () => {
  it('distinguishes missing files from present zero-byte files', async () => {
    const io = createProjectConfigFileIo();
    const filePath = path.join(tempDir, 'projects.json');

    expect(await io.read(filePath)).toEqual({ ok: true, state: 'missing' });

    await fs.writeFile(filePath, new Uint8Array());
    const present = await io.read(filePath);
    expect(present.ok).toBe(true);
    if (present.ok && present.state === 'present') expect(present.data).toHaveLength(0);
  });

  it('atomically creates and replaces opaque data', async () => {
    const io = createProjectConfigFileIo({ createTempToken: () => 'test-token' });
    const filePath = path.join(tempDir, 'nested', 'projects.json');

    expect(await io.writeAtomic(filePath, 'first')).toEqual({ ok: true });
    expect(await fs.readFile(filePath, 'utf8')).toBe('first');

    expect(await io.writeAtomic(filePath, new TextEncoder().encode('second'))).toEqual({ ok: true });
    expect(await fs.readFile(filePath, 'utf8')).toBe('second');
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['projects.json']);
  });

  it('copies an opaque backup without interpreting its contents', async () => {
    const io = createProjectConfigFileIo();
    const filePath = path.join(tempDir, 'projects.json');
    const backupPath = `${filePath}.backup.test`;
    await fs.writeFile(filePath, new Uint8Array([0, 255, 1]));

    expect(await io.backup(filePath, backupPath)).toEqual({ ok: true });
    expect(await fs.readFile(backupPath)).toEqual(Buffer.from([0, 255, 1]));
  });

  it('keeps the target and removes the temp file when replace fails', async () => {
    const files = new Map<string, string>([['/config/projects.json', 'original']]);
    const operations: ProjectConfigFileOperations = {
      readFile(filePath) {
        const value = files.get(filePath);
        if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return new TextEncoder().encode(value);
      },
      async mkdir() {},
      async copyFile(sourcePath, targetPath) {
        const value = files.get(sourcePath);
        if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        files.set(targetPath, value);
      },
      async writeFile(filePath, data) {
        files.set(filePath, typeof data === 'string' ? data : new TextDecoder().decode(data));
      },
      async rename() {
        throw Object.assign(new Error('replace failed'), { code: 'EIO' });
      },
      async unlink(filePath) {
        files.delete(filePath);
      },
    };
    const io = createProjectConfigFileIo({ operations, createTempToken: () => 'failed' });

    const result = await io.writeAtomic('/config/projects.json', 'candidate');

    expect(result).toMatchObject({ ok: false, error: { operation: 'replace' } });
    expect(files.get('/config/projects.json')).toBe('original');
    expect([...files.keys()]).toEqual(['/config/projects.json']);
  });
});
