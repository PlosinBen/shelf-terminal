import { app, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import { IPC } from '@shared/ipc-channels';
import { log } from '@shared/logger';

export function registerLogsHandlers(): void {
  ipcMain.handle(IPC.APP_LOGS_PATH, () => {
    return path.join(app.getPath('userData'), 'logs');
  });

  ipcMain.handle(IPC.LOGS_CLEAR, () => {
    const logBaseDir = path.join(app.getPath('userData'), 'logs');
    if (fs.existsSync(logBaseDir)) {
      fs.rmSync(logBaseDir, { recursive: true, force: true });
    }
    log.info('app', 'logs cleared');
  });

  /**
   * Walk logs/<YYYYMM>/<MMDD>.log, sum file sizes, count files. Used by
   * Settings → Logs to display total on-disk footprint next to Clear Logs.
   * Silently treats a missing logs dir as 0 — the UI uses `0 B` for both
   * "no files yet" and "after Clear", so the API gives the same shape.
   */
  ipcMain.handle(IPC.LOGS_SIZE, async (): Promise<{ totalBytes: number; fileCount: number }> => {
    const base = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(base)) return { totalBytes: 0, fileCount: 0 };
    let totalBytes = 0;
    let fileCount = 0;
    let monthDirs: string[] = [];
    try {
      monthDirs = await fs.promises.readdir(base);
    } catch {
      return { totalBytes: 0, fileCount: 0 };
    }
    for (const monthDir of monthDirs) {
      const dir = path.join(base, monthDir);
      const dirStat = await fs.promises.stat(dir).catch(() => null);
      if (!dirStat?.isDirectory()) continue;
      let files: string[] = [];
      try {
        files = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = path.join(dir, file);
        const fstat = await fs.promises.stat(filePath).catch(() => null);
        if (fstat?.isFile()) {
          totalBytes += fstat.size;
          fileCount++;
        }
      }
    }
    return { totalBytes, fileCount };
  });
}
