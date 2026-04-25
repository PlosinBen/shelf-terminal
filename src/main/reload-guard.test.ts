import { describe, it, expect } from 'vitest';
import { isReloadKeyEvent, type KeyEventLike } from './reload-guard';

function key(overrides: Partial<KeyEventLike>): KeyEventLike {
  return {
    type: 'keyDown',
    key: '',
    meta: false,
    control: false,
    shift: false,
    alt: false,
    ...overrides,
  };
}

describe('isReloadKeyEvent', () => {
  it('Cmd+R (macOS) → true', () => {
    expect(isReloadKeyEvent(key({ meta: true, key: 'r' }))).toBe(true);
  });

  it('Ctrl+R (Windows / Linux) → true', () => {
    expect(isReloadKeyEvent(key({ control: true, key: 'r' }))).toBe(true);
  });

  it('uppercase R with modifier (Shift held) → true', () => {
    // macOS reports `key` as uppercase 'R' when Shift is held with Cmd
    expect(isReloadKeyEvent(key({ meta: true, shift: true, key: 'R' }))).toBe(true);
  });

  it('Shift+Cmd+R (force reload variant) → true', () => {
    expect(isReloadKeyEvent(key({ meta: true, shift: true, key: 'R' }))).toBe(true);
  });

  it('F5 (no modifier) → true', () => {
    expect(isReloadKeyEvent(key({ key: 'F5' }))).toBe(true);
  });

  it('plain "r" without modifier → false (typing in terminal)', () => {
    expect(isReloadKeyEvent(key({ key: 'r' }))).toBe(false);
  });

  it('Cmd+T (other Shelf shortcut) → false', () => {
    expect(isReloadKeyEvent(key({ meta: true, key: 't' }))).toBe(false);
  });

  it('Ctrl+R on keyUp → false (only intercept the press)', () => {
    expect(isReloadKeyEvent(key({ type: 'keyUp', control: true, key: 'r' }))).toBe(false);
  });

  it('F5 on keyUp → false', () => {
    expect(isReloadKeyEvent(key({ type: 'keyUp', key: 'F5' }))).toBe(false);
  });

  it('Alt+R alone (no Cmd/Ctrl) → false', () => {
    // alt is not a "primary" modifier for reload — Cmd/Ctrl is required
    expect(isReloadKeyEvent(key({ alt: true, key: 'r' }))).toBe(false);
  });

  it('Cmd alone with no key → false', () => {
    expect(isReloadKeyEvent(key({ meta: true, key: 'Meta' }))).toBe(false);
  });
});
