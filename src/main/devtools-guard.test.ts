import { describe, it, expect } from 'vitest';
import { isDevToolsKeyEvent } from './devtools-guard';
import type { KeyEventLike } from './reload-guard';

function key(partial: Partial<KeyEventLike>): KeyEventLike {
  return { type: 'keyDown', key: '', ...partial };
}

describe('isDevToolsKeyEvent', () => {
  it('matches F12', () => {
    expect(isDevToolsKeyEvent(key({ key: 'F12' }))).toBe(true);
  });

  it('matches Ctrl+Shift+I (lower and upper case)', () => {
    expect(isDevToolsKeyEvent(key({ control: true, shift: true, key: 'I' }))).toBe(true);
    expect(isDevToolsKeyEvent(key({ control: true, shift: true, key: 'i' }))).toBe(true);
  });

  it('does NOT match Ctrl+I without shift', () => {
    expect(isDevToolsKeyEvent(key({ control: true, key: 'I' }))).toBe(false);
  });

  it('does NOT match Shift+I without ctrl', () => {
    expect(isDevToolsKeyEvent(key({ shift: true, key: 'I' }))).toBe(false);
  });

  it('ignores keyUp / non-keyDown events', () => {
    expect(isDevToolsKeyEvent(key({ type: 'keyUp', key: 'F12' }))).toBe(false);
    expect(isDevToolsKeyEvent(key({ type: 'keyUp', control: true, shift: true, key: 'I' }))).toBe(false);
  });

  it('does NOT match unrelated keys', () => {
    expect(isDevToolsKeyEvent(key({ key: 'F5' }))).toBe(false);
    expect(isDevToolsKeyEvent(key({ control: true, key: 'r' }))).toBe(false);
  });
});
