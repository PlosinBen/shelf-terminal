import { describe, it, expect } from 'vitest';
import { decideCommandPickerKey } from './CommandPicker';

/**
 * Pure-logic test for the command picker's key decision — mirrors the
 * PickerPanel approach (component DOM/keyboard wiring is deferred to E2E).
 */
describe('decideCommandPickerKey', () => {
  // ── Regression: IME composition in the filter input must win over nav ──
  // Typing CJK and pressing ↑/↓/Enter to pick a candidate must not move the
  // selection or run a command — defer every key to the IME while composing.
  it('returns none for every key while composing', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'a']) {
      expect(decideCommandPickerKey(key, true)).toBe('none');
    }
  });

  it('maps keys normally when not composing', () => {
    expect(decideCommandPickerKey('ArrowDown', false)).toBe('down');
    expect(decideCommandPickerKey('ArrowUp', false)).toBe('up');
    expect(decideCommandPickerKey('Enter', false)).toBe('execute');
    expect(decideCommandPickerKey('Escape', false)).toBe('close');
    expect(decideCommandPickerKey('x', false)).toBe('none');
  });

  // ── Tab navigates the list (and is captured so focus can't escape the
  // overlay): Tab → down, Shift+Tab → up. ──
  it('maps Tab to list navigation so focus stays trapped', () => {
    expect(decideCommandPickerKey('Tab', false)).toBe('down');
    expect(decideCommandPickerKey('Tab', false, true)).toBe('up');
  });

  it('still defers Tab to the IME while composing', () => {
    expect(decideCommandPickerKey('Tab', true)).toBe('none');
    expect(decideCommandPickerKey('Tab', true, true)).toBe('none');
  });
});
