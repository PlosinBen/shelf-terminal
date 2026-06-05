/**
 * Whether to install an in-app menu for the given platform.
 *
 * Only macOS keeps a menu — it owns the system top menu bar (a platform
 * convention, not an in-window strip). On Windows/Linux the menu would render
 * as an in-window bar that Alt reveals/toggles (tearing the layout), and
 * Electron has no clean "keep the menu but disable Alt" API, so we drop it
 * entirely there. DevTools is hardwired back via `isDevToolsKeyEvent`; the
 * update entry lives in the footer; cut/copy/paste work through Chromium/xterm
 * natively without menu accelerators.
 */
export function shouldInstallAppMenu(platform: NodeJS.Platform): boolean {
  return platform === 'darwin';
}
