import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { projectDir } from './project-storage';
import { log } from '@shared/logger';

// Per-project notes are individual markdown files with YAML frontmatter:
//   projects/<projectId>/notes/<noteId>.md
//     ---
//     title: ...
//     is_done: false
//     created: 2026-05-07T10:00:00.000Z
//     updated: 2026-05-07T11:30:00.000Z
//     ---
//
//     # markdown body…
//
// Images are still shared per project under projects/<projectId>/images/<uuid>.<ext>
// and garbage-collected against references found across ALL notes in the project.

export interface NoteMeta {
  id: string;
  title: string;
  isDone: boolean;
  created: string;
  updated: string;
}

export interface Note extends NoteMeta {
  content: string;
}

export function notesDir(projectId: string): string {
  return path.join(projectDir(projectId), 'notes');
}

export function notePath(projectId: string, noteId: string): string {
  return path.join(notesDir(projectId), `${noteId}.md`);
}

export function imagesDir(projectId: string): string {
  return path.join(projectDir(projectId), 'images');
}

export async function listNotes(projectId: string): Promise<NoteMeta[]> {
  const dir = notesDir(projectId);
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: NoteMeta[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const id = entry.name.slice(0, -'.md'.length);
    if (!isSafeId(id)) continue;

    try {
      const raw = await fs.promises.readFile(path.join(dir, entry.name), 'utf-8');
      const { meta } = parseFrontmatter(raw);
      out.push({
        id,
        title: meta.title ?? '',
        isDone: meta.isDone ?? false,
        created: meta.created ?? '',
        updated: meta.updated ?? '',
      });
    } catch (err) {
      log.error('notes-store', `failed to read note ${entry.name}`, err);
    }
  }
  // updatedAt desc — most recently touched first
  out.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  return out;
}

export async function getNote(projectId: string, noteId: string): Promise<Note | null> {
  if (!isSafeId(noteId)) return null;
  try {
    const raw = await fs.promises.readFile(notePath(projectId, noteId), 'utf-8');
    const { meta, body } = parseFrontmatter(raw);
    return {
      id: noteId,
      title: meta.title ?? '',
      isDone: meta.isDone ?? false,
      created: meta.created ?? '',
      updated: meta.updated ?? '',
      content: body,
    };
  } catch {
    return null;
  }
}

export async function createNote(projectId: string): Promise<NoteMeta> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const meta: NoteMeta = { id, title: '', isDone: false, created: now, updated: now };
  await writeRaw(projectId, id, meta, '');
  return meta;
}

export async function updateNote(
  projectId: string,
  noteId: string,
  patch: { title?: string; isDone?: boolean; content?: string },
): Promise<NoteMeta | null> {
  if (!isSafeId(noteId)) return null;
  const existing = await getNote(projectId, noteId);
  if (!existing) return null;

  const next: NoteMeta = {
    id: existing.id,
    title: patch.title ?? existing.title,
    isDone: patch.isDone ?? existing.isDone,
    created: existing.created,
    updated: new Date().toISOString(),
  };
  const body = patch.content ?? existing.content;
  await writeRaw(projectId, noteId, next, body);
  await garbageCollectImages(projectId);
  return next;
}

export async function deleteNote(projectId: string, noteId: string): Promise<void> {
  if (!isSafeId(noteId)) return;
  try {
    await fs.promises.unlink(notePath(projectId, noteId));
  } catch (err) {
    log.error('notes-store', `delete failed: ${noteId}`, err);
  }
  await garbageCollectImages(projectId);
}

export async function saveImage(projectId: string, buffer: ArrayBuffer, ext: string): Promise<string> {
  const safeExt = sanitizeExt(ext);
  const dir = imagesDir(projectId);
  await fs.promises.mkdir(dir, { recursive: true });
  const filename = `${crypto.randomUUID()}${safeExt}`;
  await fs.promises.writeFile(path.join(dir, filename), Buffer.from(buffer));
  return `images/${filename}`;
}

// ── Auto-GC across all notes ───────────────────────────────────

const IMAGE_REF_RE = /images\/([\w.-]+)/g;

export async function garbageCollectImages(projectId: string): Promise<number> {
  const dir = imagesDir(projectId);
  if (!fs.existsSync(dir)) return 0;

  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }

  // Walk every note's raw content (frontmatter + body) and collect refs.
  const refs = new Set<string>();
  const ndir = notesDir(projectId);
  if (fs.existsSync(ndir)) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(ndir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      try {
        const raw = await fs.promises.readFile(path.join(ndir, entry.name), 'utf-8');
        for (const m of raw.matchAll(IMAGE_REF_RE)) refs.add(m[1]);
      } catch {
        // skip unreadable file
      }
    }
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

// ── Internal helpers ───────────────────────────────────────────

interface ParsedFrontmatter {
  meta: { title?: string; isDone?: boolean; created?: string; updated?: string };
  body: string;
}

// Tiny frontmatter parser. Only supports the four scalar fields we use; intentional
// constraint to avoid pulling in a YAML library for this much.
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const meta: ParsedFrontmatter['meta'] = {};
  if (!raw.startsWith('---\n')) {
    return { meta, body: raw };
  }
  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) {
    return { meta, body: raw };
  }
  const header = raw.slice(4, end);
  const body = raw.slice(end + '\n---\n'.length);

  for (const line of header.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!m) continue;
    const key = m[1];
    const valueRaw = m[2].trim();
    const value = unquote(valueRaw);
    if (key === 'title') meta.title = value;
    else if (key === 'is_done') meta.isDone = value === 'true';
    else if (key === 'created') meta.created = value;
    else if (key === 'updated') meta.updated = value;
  }
  return { meta, body };
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

function quoteForYaml(s: string): string {
  // Quote when the string contains characters that would confuse our naive parser.
  if (/^[A-Za-z0-9._\-:\/+ ]*$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function serialize(meta: NoteMeta, body: string): string {
  return [
    '---',
    `title: ${quoteForYaml(meta.title)}`,
    `is_done: ${meta.isDone}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    '---',
    body,
  ].join('\n');
}

async function writeRaw(projectId: string, noteId: string, meta: NoteMeta, body: string): Promise<void> {
  const dir = notesDir(projectId);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(notePath(projectId, noteId), serialize(meta, body), 'utf-8');
}

function sanitizeExt(ext: string): string {
  const cleaned = ext.toLowerCase().replace(/^\./, '');
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(cleaned)) return `.${cleaned}`;
  return '.png';
}

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}
