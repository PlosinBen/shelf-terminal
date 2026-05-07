import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { ensureProjectDir, projectDir } from './project-storage';
import { log } from '@shared/logger';

export function notePath(projectId: string): string {
  return path.join(projectDir(projectId), 'notes.md');
}

export function imagesDir(projectId: string): string {
  return path.join(projectDir(projectId), 'images');
}

export async function readNote(projectId: string): Promise<string> {
  try {
    return await fs.promises.readFile(notePath(projectId), 'utf-8');
  } catch {
    return '';
  }
}

export async function writeNote(projectId: string, content: string): Promise<void> {
  ensureProjectDir(projectId);
  await fs.promises.writeFile(notePath(projectId), content, 'utf-8');
  await garbageCollectImages(projectId, content);
}

// Match `images/<name>` references inside markdown image syntax: ![alt](images/foo.png)
// or HTML: <img src="images/foo.png">. We capture the bare filename part.
const IMAGE_REF_RE = /images\/([\w.-]+)/g;

function extractImageRefs(content: string): Set<string> {
  const refs = new Set<string>();
  for (const m of content.matchAll(IMAGE_REF_RE)) {
    refs.add(m[1]);
  }
  return refs;
}

export async function garbageCollectImages(projectId: string, noteContent: string): Promise<number> {
  const dir = imagesDir(projectId);
  if (!fs.existsSync(dir)) return 0;

  const refs = extractImageRefs(noteContent);
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const file of files) {
    if (!refs.has(file)) {
      try {
        await fs.promises.unlink(path.join(dir, file));
        removed++;
      } catch (err) {
        log.error('notes-store', `gc unlink failed: ${file}`, err);
      }
    }
  }
  return removed;
}

export async function saveImage(projectId: string, buffer: ArrayBuffer, ext: string): Promise<string> {
  const safeExt = sanitizeExt(ext);
  const dir = imagesDir(projectId);
  await fs.promises.mkdir(dir, { recursive: true });
  const filename = `${crypto.randomUUID()}${safeExt}`;
  await fs.promises.writeFile(path.join(dir, filename), Buffer.from(buffer));
  return `images/${filename}`;
}

function sanitizeExt(ext: string): string {
  // Allow only common image extensions; default to .png.
  const cleaned = ext.toLowerCase().replace(/^\./, '');
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(cleaned)) return `.${cleaned}`;
  return '.png';
}
