import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Project } from '@shared/projects';
import { readLinkFile } from './link-file-preview';
import { LINK_OPEN } from '@shared/link-open-intent';

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
});
