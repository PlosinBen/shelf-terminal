import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { ProcessMemorySummary } from '@shared/process-memory';
import { getMainWindow } from '../app-state';
import {
  getCurrentProcessMemorySummary,
  setProcessMemorySummarySink,
} from '../process-memory-manager';

export function registerProcessMemoryHandlers(): void {
  ipcMain.handle(
    IPC.AGENT_MEMORY_USAGE_CURRENT,
    (): ProcessMemorySummary | null => getCurrentProcessMemorySummary(),
  );

  setProcessMemorySummarySink((summary) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC.AGENT_MEMORY_USAGE, summary);
  });
}
