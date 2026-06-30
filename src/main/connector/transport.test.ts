import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Connection } from '@shared/types';

// Mock the connector factory so we can capture putFile without touching a real
// ssh/docker/wsl target (or the real home dir).
const putFile = vi.fn(async () => {});
const homePath = vi.fn(async () => '/home/worker');
vi.mock('./index', () => ({
  createConnector: () => ({ homePath, putFile }),
}));

const { transportPut, transportPutDir, composeRemotePath } = await import('./transport');

const conn = { type: 'ssh' } as unknown as Connection;
let tmpDir: string;
let srcFile: string;

beforeEach(() => {
  putFile.mockClear();
  homePath.mockClear();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-transport-'));
  srcFile = path.join(tmpDir, 'mcp-servers.json');
  fs.writeFileSync(srcFile, '{"github":{"type":"stdio","command":"node"}}');
});
afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('composeRemotePath', () => {
  it('joins base + rel, trimming trailing slashes on base', () => {
    expect(composeRemotePath('/home/worker', '.shelf/apps/a/mcp-servers.json'))
      .toBe('/home/worker/.shelf/apps/a/mcp-servers.json');
    expect(composeRemotePath('/home/worker/', 'x/y')).toBe('/home/worker/x/y');
  });
});

describe('transportPut', () => {
  it('resolves home on the worker, composes the type path, and putFiles the bytes', async () => {
    await transportPut(conn, { type: 'mcp', context: { appId: 'app-1' }, source: { localPath: srcFile } });
    expect(homePath).toHaveBeenCalledTimes(1); // base resolved on the worker, not hardcoded
    expect(putFile).toHaveBeenCalledTimes(1);
    const [dest, buffer] = putFile.mock.calls[0] as unknown as [string, Buffer];
    expect(dest).toBe('/home/worker/.shelf/apps/app-1/mcp-servers.json');
    expect(buffer.toString()).toBe('{"github":{"type":"stdio","command":"node"}}');
  });

  it('throws on an unknown type (closed allowlist) before any transfer', async () => {
    await expect(
      transportPut(conn, { type: 'bogus' as any, context: { appId: 'a' }, source: { localPath: srcFile } }),
    ).rejects.toThrow(/Unknown shelf file type/);
    expect(putFile).not.toHaveBeenCalled();
  });

  it('accepts an in-memory buffer source (no temp file)', async () => {
    await transportPut(conn, { type: 'mcp', context: { appId: 'app-1' }, source: { buffer: Buffer.from('inline') } });
    const [dest, buffer] = putFile.mock.calls[0] as unknown as [string, Buffer];
    expect(dest).toBe('/home/worker/.shelf/apps/app-1/mcp-servers.json');
    expect(buffer.toString()).toBe('inline');
  });
});

describe('transportPutDir', () => {
  it('resolves home ONCE then putFiles each file under the type dir', async () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    const a = path.join(tmpDir, 'SKILL.md');
    const b = path.join(tmpDir, 'sub', 'script.sh');
    fs.writeFileSync(a, 'skill-a');
    fs.writeFileSync(b, 'script-b');

    await transportPutDir(conn, {
      type: 'skill',
      context: { appId: 'app-1' },
      files: [
        { rel: 'SKILL.md', localPath: a },
        { rel: 'sub/script.sh', localPath: b },
      ],
    });

    expect(homePath).toHaveBeenCalledTimes(1); // base resolved once, not per file
    expect(putFile).toHaveBeenCalledTimes(2);
    const calls = putFile.mock.calls as unknown as Array<[string, Buffer]>;
    expect(calls[0][0]).toBe('/home/worker/.shelf/apps/app-1/skills/SKILL.md');
    expect(calls[0][1].toString()).toBe('skill-a');
    expect(calls[1][0]).toBe('/home/worker/.shelf/apps/app-1/skills/sub/script.sh');
    expect(calls[1][1].toString()).toBe('script-b');
  });

  it('throws on an unknown type before any transfer', async () => {
    await expect(
      transportPutDir(conn, { type: 'bogus' as any, context: { appId: 'a' }, files: [] }),
    ).rejects.toThrow(/Unknown shelf file type/);
    expect(putFile).not.toHaveBeenCalled();
  });
});
