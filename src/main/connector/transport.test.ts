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

const { transportPut, composeRemotePath } = await import('./transport');

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
});
