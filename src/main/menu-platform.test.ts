import { describe, it, expect } from 'vitest';
import { shouldInstallAppMenu } from './menu-platform';

describe('shouldInstallAppMenu', () => {
  it('installs the menu on macOS (owns the system top bar)', () => {
    expect(shouldInstallAppMenu('darwin')).toBe(true);
  });

  // Regression guard (R0): Windows/Linux must NOT install an in-window menu —
  // the Alt-reveals-menu strip is exactly what this change removed. If anyone
  // re-enables it by habit, this breaks loudly.
  it('does NOT install the menu on Windows or Linux', () => {
    expect(shouldInstallAppMenu('win32')).toBe(false);
    expect(shouldInstallAppMenu('linux')).toBe(false);
  });
});
