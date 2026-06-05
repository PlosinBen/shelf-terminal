import { test, expect } from './helpers';
import type { ElectronApplication } from '@playwright/test';

/**
 * DevTools hardwire E2E (R0). On Win/Linux we drop the menu (and its
 * toggleDevTools accelerator); on every platform F12 / Ctrl+Shift+I are
 * hardwired in main's `before-input-event` (devtools-guard.ts → index.ts).
 *
 * Why `sendInputEvent` and not `page.keyboard`: Playwright's keyboard dispatches
 * via CDP straight to the renderer DOM, which does NOT trigger Electron's
 * `before-input-event` — the exact main-process hook this feature lives in (so
 * it survives a dead renderer). `webContents.sendInputEvent` goes through the
 * native input pipeline and DOES fire `before-input-event`, so it exercises the
 * real chain: keystroke → before-input-event → isDevToolsKeyEvent →
 * toggleDevTools. The unit test only covers the predicate in isolation.
 */

function sendKey(
  app: ElectronApplication,
  keyCode: string,
  modifiers: string[] = [],
): Promise<void> {
  return app.evaluate(({ BrowserWindow }, { keyCode, modifiers }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: modifiers as any });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: modifiers as any });
  }, { keyCode, modifiers });
}

function devToolsOpen(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return !!win && win.webContents.isDevToolsOpened();
  });
}

test.describe('DevTools hardwire', () => {
  test('F12 toggles Chromium DevTools open then closed', async ({ shelfApp: { app } }) => {
    expect(await devToolsOpen(app)).toBe(false);

    await sendKey(app, 'F12');
    await expect.poll(() => devToolsOpen(app), { timeout: 5_000 }).toBe(true);

    await sendKey(app, 'F12');
    await expect.poll(() => devToolsOpen(app), { timeout: 5_000 }).toBe(false);
  });

  test('Ctrl+Shift+I opens Chromium DevTools', async ({ shelfApp: { app } }) => {
    expect(await devToolsOpen(app)).toBe(false);

    await sendKey(app, 'I', ['control', 'shift']);
    await expect.poll(() => devToolsOpen(app), { timeout: 5_000 }).toBe(true);
  });
});
