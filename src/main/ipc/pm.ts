import { ipcMain, net } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { log } from '@shared/logger';
import type { PmListModelsResult, ProviderModel } from '@shared/types';
import {
  handlePmSend,
  getHistory,
  clearHistory,
  compactHistory,
  stopGeneration,
  updateSyncedState,
  isAwayMode,
  setAwayMode,
  updateKnownTabs,
} from '../pm';
import { getMainWindow, getSettings } from '../app-state';

const LIST_MODELS_TIMEOUT_MS = 3000;

async function listModelsFromBaseURL(baseURL: string): Promise<PmListModelsResult> {
  if (!baseURL || typeof baseURL !== 'string') {
    return { ok: false, error: 'parse_error' };
  }
  const url = `${baseURL.replace(/\/+$/, '')}/models`;
  try {
    const res = await net.fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.debug('pm-list-models', `non-ok status ${res.status} from ${url}`);
      return { ok: false, error: 'unreachable' };
    }
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!data || !Array.isArray(data.data)) {
      return { ok: false, error: 'parse_error' };
    }
    const models: ProviderModel[] = data.data
      .filter((m): m is { id: string } => !!m && typeof m.id === 'string' && m.id.length > 0)
      .map((m) => ({ id: m.id }));
    return { ok: true, models };
  } catch (e: any) {
    // AbortSignal.timeout fires `TimeoutError`; manual abort fires `AbortError`.
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return { ok: false, error: 'timeout' };
    }
    log.debug('pm-list-models', `fetch failed ${url}: ${e?.message ?? String(e)}`);
    return { ok: false, error: 'unreachable' };
  }
}

export function registerPmHandlers(): void {
  ipcMain.handle(IPC.PM_SEND, async (_event, message: string) => {
    const mainWindow = getMainWindow();
    const settings = getSettings();
    if (!mainWindow || !settings.pmProvider) return;
    await handlePmSend(message, settings.pmProvider, mainWindow);
  });

  ipcMain.handle(IPC.PM_STOP, () => {
    stopGeneration();
  });

  ipcMain.handle(IPC.PM_HISTORY, () => {
    return getHistory();
  });

  ipcMain.handle(IPC.PM_CLEAR, () => {
    clearHistory();
  });

  ipcMain.handle(IPC.PM_COMPACT, () => {
    return compactHistory();
  });

  ipcMain.on(IPC.PM_SYNC_STATE, (_event, state: any) => {
    updateSyncedState(state);
    // Also update tab watcher's known tabs
    const tabs: { tabId: string; tabName: string; projectName: string }[] = [];
    for (const proj of state) {
      for (const tab of proj.tabs) {
        tabs.push({ tabId: tab.id, tabName: tab.label, projectName: proj.name });
      }
    }
    updateKnownTabs(tabs);
  });

  ipcMain.handle(IPC.PM_AWAY_MODE, (_event, on: boolean) => {
    setAwayMode(on);
  });

  ipcMain.handle(IPC.PM_AWAY_MODE_GET, () => {
    return isAwayMode();
  });

  ipcMain.handle(IPC.PM_LIST_MODELS, async (_event, baseURL: string): Promise<PmListModelsResult> => {
    return await listModelsFromBaseURL(baseURL);
  });
}
