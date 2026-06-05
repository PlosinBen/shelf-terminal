/**
 * Pure window-lifecycle decisions, isolated from the side-effectful `app`
 * wiring in index.ts so they can be unit-tested without booting Electron.
 */

/**
 * Whether an `activate` event should (re)create the main window.
 *
 * macOS emits `activate` on launch, and it can arrive BEFORE `app` is ready.
 * Constructing a `BrowserWindow` then throws
 *   "Cannot create BrowserWindow before app is ready"
 * and crashes the main process on startup. So we recreate ONLY when the app is
 * ready AND no window currently exists (e.g. a dock click after every window
 * was closed).
 */
export function shouldRecreateWindowOnActivate(appReady: boolean, hasWindow: boolean): boolean {
  return appReady && !hasWindow;
}
