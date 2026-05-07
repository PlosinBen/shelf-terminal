import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { log } from '@shared/logger';
import { ensureProjectDir, projectsRoot } from '../project-storage';

// Migrate <userData>/pm-notes/<projectId>.md → <userData>/projects/<projectId>/pm-note.md
// Idempotent: safe to re-run; copies first then unlinks so a partial run
// can be resumed on next launch without data loss.

export async function migratePmNotes(): Promise<void> {
  const oldDir = path.join(app.getPath('userData'), 'pm-notes');
  if (!fs.existsSync(oldDir)) return;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(oldDir, { withFileTypes: true });
  } catch (err) {
    log.error('migrate-pm-notes', `readdir failed for ${oldDir}`, err);
    return;
  }

  let migrated = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;

    const projectId = entry.name.slice(0, -'.md'.length);
    if (!projectId) continue;

    const src = path.join(oldDir, entry.name);
    const destDir = ensureProjectDir(projectId);
    const dest = path.join(destDir, 'pm-note.md');

    if (fs.existsSync(dest)) {
      // Already migrated for this project — drop the stale source.
      try { await fs.promises.unlink(src); } catch (err) {
        log.error('migrate-pm-notes', `unlink stale src ${src}`, err);
      }
      continue;
    }

    try {
      await fs.promises.copyFile(src, dest);
      // Verify by stat — only unlink after dest is on disk.
      await fs.promises.stat(dest);
      await fs.promises.unlink(src);
      migrated++;
    } catch (err) {
      log.error('migrate-pm-notes', `failed to migrate ${src}`, err);
    }
  }

  // Try to remove the old dir if it's empty now.
  try {
    const remaining = await fs.promises.readdir(oldDir);
    if (remaining.length === 0) {
      await fs.promises.rmdir(oldDir);
    }
  } catch {
    // ignore
  }

  if (migrated > 0) {
    log.info('migrate-pm-notes', `migrated ${migrated} pm-note(s) into ${projectsRoot()}`);
  }
}
