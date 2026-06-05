import type { KeyEventLike } from './reload-guard';

/**
 * Predicate that decides whether a webContents `before-input-event` keystroke
 * should toggle Chromium DevTools.
 *
 * Why this exists (R0): on Windows/Linux we drop the in-window menu bar to kill
 * the Alt-reveals-menu tearing. DevTools was previously reachable only through
 * the menu's `role: 'toggleDevTools'`, so removing the menu would silently take
 * it away. We hardwire F12 / Ctrl+Shift+I here instead.
 *
 * Deliberately matches the cross-platform key matrix in a pure predicate (like
 * `isReloadKeyEvent`) so it can be unit-tested without Electron. Wired on all
 * platforms: on Win/Linux it replaces the removed menu accelerator; on macOS
 * the View menu still owns DevTools via Cmd+Alt+I, which F12 / Ctrl+Shift+I
 * don't collide with — so this is purely additive there (no double-toggle).
 *
 * NOT routed through the renderer keybinding system on purpose: DevTools is the
 * escape hatch you reach for when the renderer is broken; living in the main
 * `before-input-event` layer keeps it working even if the renderer is dead.
 * (Note: the renderer's `toggleDevTools` keybinding opens the app's own
 * DevToolsPanel — a different thing that happens to share the name.)
 */
export function isDevToolsKeyEvent(input: KeyEventLike): boolean {
  if (input.type !== 'keyDown') return false;
  if (input.key === 'F12') return true;
  if (input.control && input.shift && (input.key === 'i' || input.key === 'I')) return true;
  return false;
}
