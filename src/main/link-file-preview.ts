import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINK_OPEN, type LinkOpenInput, type LinkOpenResult } from '@shared/link-open-intent';
import type { Project } from '@shared/projects';

export async function readLinkFile(input: LinkOpenInput, project: Project): Promise<LinkOpenResult> {
  if (project.connection.type !== 'local') throw new Error('File preview is unavailable for this remote connection');
  let file = input.url;
  let line: number | undefined;
  const location = /(?:#L?(\d+)(?:C\d+)?(?:(?:-L?\d+))?|:(\d+)(?::\d+)?)$/.exec(file);
  if (location) {
    line = Number(location[1] ?? location[2]);
    if (!Number.isSafeInteger(line) || line < 1) throw new Error('Invalid file line number');
    file = file.slice(0, location.index);
  }
  if (/^file:/i.test(file)) file = fileURLToPath(file);
  else file = decodeURIComponent(file);
  if (!file || file.includes('\0')) throw new Error('Invalid file path');
  const resolved = path.resolve(project.cwd, file);
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
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) throw new Error('Binary files cannot be previewed');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('File preview requires UTF-8 text'); }
    return { kind: 'file', url: input.url, path: resolved, content, line };
  } finally {
    await handle.close();
  }
}
