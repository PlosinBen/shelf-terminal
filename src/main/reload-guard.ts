/**
 * Predicate that decides whether a webContents `before-input-event` keystroke
 * should be intercepted as a reload attempt. Extracted from the wiring layer
 * so the cross-platform key matrix (Cmd/Ctrl+R, Shift+Cmd/Ctrl+R, F5) can be
 * unit-tested without spinning up Electron.
 */
export interface KeyEventLike {
  type: string;
  meta?: boolean;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
  key: string;
}

export function isReloadKeyEvent(input: KeyEventLike): boolean {
  if (input.type !== 'keyDown') return false;
  const mod = !!(input.meta || input.control);
  if (mod && (input.key === 'r' || input.key === 'R')) return true;
  if (input.key === 'F5') return true;
  return false;
}
