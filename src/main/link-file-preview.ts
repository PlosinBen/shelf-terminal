import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINK_OPEN, type LinkOpenInput, type LinkOpenResult } from '@shared/link-open-intent';
import type { Project } from '@shared/projects';
import { readRemotePreviewBytes, type PreviewRuntime } from './connector/preview-read';

export async function readLinkFile(input: LinkOpenInput, project: Project, runtime?: PreviewRuntime): Promise<LinkOpenResult> {
  const remote = project.connection.type !== 'local';
  if (remote && !runtime) throw new Error('File preview requires a remote connector');
  let file = input.url;
  let line: number | undefined;
  const location = /(?:#L?(\d+)(?:C\d+)?(?:(?:-L?\d+))?|:(\d+)(?::\d+)?)$/.exec(file);
  if (location) {
    line = Number(location[1] ?? location[2]);
    if (!Number.isSafeInteger(line) || line < 1) throw new Error('Invalid file line number');
    file = file.slice(0, location.index);
  }
  if (remote && /^file:/i.test(file)) {
    const url = new URL(file);
    if ((url.hostname && url.hostname !== 'localhost') || url.search) throw new Error('Unsupported remote file URL');
    file = decodeURIComponent(url.pathname);
  } else if (/^file:/i.test(file)) file = fileURLToPath(file);
  else file = decodeURIComponent(file);
  if (!file || file.includes('\0')) throw new Error('Invalid file path');
  if (remote && (!path.posix.isAbsolute(project.cwd) || /^[a-z]:[\\/]/i.test(file))) throw new Error('Remote preview requires a POSIX worker path');
  const resolved = remote ? path.posix.resolve(project.cwd, file) : path.resolve(project.cwd, file);
  const bytes = remote ? await readRemotePreviewBytes(runtime!, resolved) : await readLocalBytes(resolved);
  if (bytes.includes(0)) throw new Error('Binary files cannot be previewed');
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('File preview requires UTF-8 text'); }
  return { kind: 'file', url: input.url, path: resolved, content, line };
}

async function readLocalBytes(resolved: string): Promise<Buffer> {
  const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Only regular files can be previewed');
    if (stat.size > LINK_OPEN.maxFileBytes) throw new Error('File preview is limited to 1 MiB');
    const buffer = Buffer.alloc(LINK_OPEN.maxFileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > LINK_OPEN.maxFileBytes) throw new Error('File preview is limited to 1 MiB');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
