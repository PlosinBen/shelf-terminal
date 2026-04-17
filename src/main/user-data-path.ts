import { app } from 'electron';

// Single source of truth for userData isolation. Called once, top-level
// in src/main/index.ts — must run before app.whenReady() and before any
// Electron internals (Cookies, Cache, Preferences) touch userData.
//
// Isolation is driven entirely by intrinsic signals from Electron itself,
// no env vars, no build-time inlining:
//
//   - app.isPackaged = true  → real end-user install, use OS-default path
//     (e.g. ~/Library/Application Support/shelf-terminal on macOS).
//
//   - --user-data-dir=<path> passed on the command line → caller is in
//     charge of the path (E2E tests pass a fresh tempdir each run), so
//     we stay out of the way.
//
//   - Otherwise (dev / `npx electron .` / `npm run pack` output) → append
//     `-dev` suffix. Safe-by-default: any unpackaged launch that did not
//     explicitly pick its own path gets isolated from production data.

let applied = false;

export function applyUserDataIsolation(): void {
  if (applied) return;
  applied = true;
  if (app.isPackaged) return;
  if (app.commandLine.hasSwitch('user-data-dir')) return;
  app.setPath('userData', app.getPath('userData') + '-dev');
}

// Test-only. Production code never resets the guard.
export function __resetForTests(): void {
  applied = false;
}
