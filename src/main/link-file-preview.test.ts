import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Project } from '@shared/projects';
import { readLinkFile } from './link-file-preview';
import { LINK_OPEN } from '@shared/link-open-intent';
import { spawn } from 'node:child_process';
import { vi } from 'vitest';

let root: string;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
describe('read-only file link preview', () => {
  async function setup() {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelf-preview-'));
    return { cwd: root, connection: { type: 'local' } } as Project;
  }
  const input = (url: string) => ({ url, reason: 'Link', source: { kind: 'project-tab' as const, projectId: 'p', tabId: 'v' } });
  it('resolves relative paths in the owning project, with line references and inert HTML', async () => {
    const project = await setup();
    await fs.writeFile(path.join(root, 'a b.html'), '<script>throw new Error()</script>\nline 2');
    const result = await readLinkFile(input('./a%20b.html#L2'), project);
    expect(result).toMatchObject({ kind: 'file', path: path.join(root, 'a b.html'), line: 2, content: '<script>throw new Error()</script>\nline 2' });
    expect(await readLinkFile(input(`${pathToFileURL(path.join(root, 'a b.html')).href}#L2`), project)).toMatchObject({ kind: 'file', line: 2 });
    expect(await readLinkFile(input(`${path.join(root, 'a b.html')}:2:3`), project)).toMatchObject({ kind: 'file', line: 2 });
  });
  it('rejects missing files, directories, binary, invalid UTF-8 and oversized files', async () => {
    const project = await setup();
    await expect(readLinkFile(input('./missing'), project)).rejects.toThrow();
    await expect(readLinkFile(input('.'), project)).rejects.toThrow('regular');
    for (const bytes of [Buffer.from([0]), Buffer.from([255]), Buffer.alloc(LINK_OPEN.maxFileBytes + 1, 65)]) {
      await fs.writeFile(path.join(root, 'bad'), bytes);
      await expect(readLinkFile(input('./bad'), project)).rejects.toThrow();
    }
  });
  it('never reads a remote path as a local path', async () => {
    const project = await setup();
    await fs.writeFile(path.join(root, 'secret'), 'host data');
    await expect(readLinkFile(input('./secret'), { ...project, connection: { type: 'ssh', host: 'host', port: 22, user: 'u' } })).rejects.toThrow('remote');
  });
  it('uses the source connector for bounded remote bytes and quoted file paths', async () => {
    const local = await setup();
    const filename = "quote';$(echo injected).txt";
    await fs.writeFile(path.join(root, filename), 'remote first\nremote second');
    const connector = {
      isConnected: vi.fn(async () => true), isCurrentGeneration: () => true,
      spawnProcess: vi.fn((request: import('./connector/types').ProcessRequest) => spawn(request.executable, [...request.args], { cwd: request.cwd })),
    };
    const remote = { ...local, connection: { type: 'docker' as const, container: 'worker' } };
    const result = await readLinkFile(input(`${encodeURIComponent(filename)}#L2`), remote, connector);
    expect(result).toMatchObject({ kind: 'file', path: path.join(root, filename), content: 'remote first\nremote second', line: 2 });
    expect(connector.spawnProcess).toHaveBeenCalledOnce();
    await expect(readLinkFile(input('./missing'), remote, connector)).rejects.toThrow('regular');
    await fs.writeFile(path.join(root, 'huge'), Buffer.alloc(LINK_OPEN.maxFileBytes + 2, 65));
    await expect(readLinkFile(input('./huge'), remote, connector)).rejects.toThrow('1 MiB');
    await expect(readLinkFile(input('.'), remote, connector)).rejects.toThrow('regular');
  });
  it('does not spawn or fall back to host files for disconnected or stale remote runtimes', async () => {
    const local = await setup();
    await fs.writeFile(path.join(root, 'secret'), 'host data');
    const remote = { ...local, connection: { type: 'ssh' as const, host: 'worker', user: 'u', port: 22 } };
    const connector = { isConnected: vi.fn(async () => false), isCurrentGeneration: () => true, spawnProcess: vi.fn() };
    await expect(readLinkFile(input('./secret'), remote, connector)).rejects.toThrow('disconnected');
    expect(connector.spawnProcess).not.toHaveBeenCalled();
    await expect(readLinkFile(input('./secret'), remote, { ...connector, isCurrentGeneration: () => false })).rejects.toThrow('changed');
    expect(connector.spawnProcess).not.toHaveBeenCalled();
  });
});
