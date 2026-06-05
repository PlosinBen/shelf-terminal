import { describe, it, expect } from 'vitest';
import { shouldRecreateWindowOnActivate } from './window-lifecycle';

/**
 * Regression for the production startup crash:
 *
 *   Uncaught Exception: Error: Cannot create BrowserWindow before app is ready
 *
 * macOS emits `activate` on launch, and it can arrive BEFORE `app` becomes
 * ready. The old activate handler only checked "no window exists yet" and
 * called createWindow() unconditionally — so a pre-ready activate constructed
 * a BrowserWindow before the app was ready and crashed the main process on
 * startup. The guard must also require the app to be ready.
 */
describe('shouldRecreateWindowOnActivate', () => {
  it('does NOT create a window before the app is ready (the crash case)', () => {
    // Pre-ready activate on launch: app not ready, no window yet.
    expect(shouldRecreateWindowOnActivate(false, false)).toBe(false);
  });

  it('does not create one before ready even if somehow flagged window-less', () => {
    expect(shouldRecreateWindowOnActivate(false, true)).toBe(false);
  });

  it('recreates when ready and no window exists (dock click after all closed)', () => {
    expect(shouldRecreateWindowOnActivate(true, false)).toBe(true);
  });

  it('does not create a second window when one already exists', () => {
    expect(shouldRecreateWindowOnActivate(true, true)).toBe(false);
  });
});
