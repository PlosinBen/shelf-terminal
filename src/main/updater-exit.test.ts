import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => void>(),
  quitAndInstall: vi.fn(),
  showMessageBox: vi.fn(),
}));
vi.mock('electron-updater', () => ({ autoUpdater: {
  on: (event: string, handler: (...args: any[]) => void) => { mocks.handlers.set(event, handler); },
  quitAndInstall: mocks.quitAndInstall,
  checkForUpdates: vi.fn(async () => {}),
} }));
vi.mock('electron', () => ({ app: { getVersion: () => 'test' }, dialog: { showMessageBox: mocks.showMessageBox } }));

import { initAutoUpdater, confirmAndInstallUpdate, stopAutoUpdater } from './updater';
import type { BrowserWindow } from 'electron';

afterEach(() => { stopAutoUpdater(); vi.clearAllMocks(); });

it('does not install when history preparation is cancelled, and installs only inside an approved commit', async () => {
  const window = { isDestroyed: () => false, on: vi.fn(), webContents: { send: vi.fn() } } as unknown as BrowserWindow;
  const requestExit = vi.fn(async (_commit: () => void) => false);
  mocks.showMessageBox.mockResolvedValue({ response: 1 });
  initAutoUpdater(window, requestExit);
  mocks.handlers.get('update-downloaded')!({ version: 'test-next' });
  await confirmAndInstallUpdate();
  expect(requestExit).toHaveBeenCalledOnce();
  expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  requestExit.mockImplementationOnce(async commit => { commit(); return true; });
  await confirmAndInstallUpdate();
  expect(mocks.quitAndInstall).toHaveBeenCalledOnce();
});
