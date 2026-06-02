import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { uploadFile, clearUploads, getUploadsSize } from '../file-transfer';
import { log } from '@shared/logger';
import type { Connection, FileUploadResult, FileClearResult } from '@shared/types';

export function registerFileTransferHandlers(): void {
  ipcMain.handle(
    IPC.FILE_UPLOAD,
    async (_event, payload: { connection: Connection; cwd: string; filename: string; buffer: ArrayBuffer }): Promise<FileUploadResult> => {
      try {
        const remotePath = await uploadFile(
          payload.connection,
          payload.cwd,
          payload.filename,
          Buffer.from(payload.buffer),
        );
        return { ok: true, remotePath };
      } catch (err: any) {
        const message = err?.message ?? String(err);
        log.error('file-transfer', `upload failed: ${message}`);
        return { ok: false, reason: message };
      }
    },
  );

  ipcMain.handle(
    IPC.FILE_CLEAR_UPLOADS,
    async (_event, payload: { connection: Connection; cwd: string }): Promise<FileClearResult> => {
      try {
        const removed = await clearUploads(payload.connection, payload.cwd);
        return { ok: true, removed };
      } catch (err: any) {
        const message = err?.message ?? String(err);
        log.error('file-transfer', `clearUploads failed: ${message}`);
        return { ok: false, reason: message };
      }
    },
  );

  /**
   * Powers the "X MB · N files" badge next to Clear uploaded files in
   * Project Edit. On any failure (remote unreachable, dir missing) the
   * connector itself returns zeros — we surface that as a zeroed result
   * rather than throwing, so the UI displays `0 B` instead of a flash of
   * error text. Caller still has to gate on connectivity for remote
   * projects (no point asking when the connection is down).
   */
  ipcMain.handle(
    IPC.FILE_UPLOADS_SIZE,
    async (_event, payload: { connection: Connection; cwd: string }): Promise<{ totalBytes: number; fileCount: number }> => {
      try {
        return await getUploadsSize(payload.connection, payload.cwd);
      } catch (err: any) {
        log.debug('file-transfer', `getUploadsSize failed: ${err?.message ?? err}`);
        return { totalBytes: 0, fileCount: 0 };
      }
    },
  );
}
