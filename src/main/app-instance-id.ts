import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { app } from 'electron';

/**
 * Stable per-install identifier (see deployment#1 / feature §5.3). Generated
 * once and persisted in userData; survives restarts and app updates, only
 * regenerating on a full reinstall / userData wipe. Because it lives in
 * userData, dev/test/prod each get their own id (the `-dev` userData isolation)
 * — so they never collide when projecting skills onto a shared remote.
 *
 * Used as the namespace for per-app projected data under `~/.shelf/apps/<id>/`.
 */
let cached: string | null = null;

function idFilePath(): string {
  return path.join(app.getPath('userData'), 'app-instance-id');
}

export function getAppInstanceId(): string {
  if (cached) return cached;
  const file = idFilePath();
  try {
    const existing = fs.readFileSync(file, 'utf-8').trim();
    if (existing) {
      cached = existing;
      return existing;
    }
  } catch {
    /* not created yet */
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id + '\n', 'utf-8');
  } catch {
    /* best-effort persist; fall back to the in-memory id for this run */
  }
  cached = id;
  return id;
}
