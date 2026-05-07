import { describe, it, expect } from 'vitest';
import { formatCombo, tooltipWithShortcut } from './format-keybinding';

describe('formatCombo', () => {
  describe('mac', () => {
    it('mod+d → ⌘D', () => {
      expect(formatCombo('mod+d', true)).toBe('⌘D');
    });
    it('mod+shift+[ → ⌘⇧[', () => {
      expect(formatCombo('mod+shift+[', true)).toBe('⌘⇧[');
    });
    it('mod+alt+t → ⌘⌥T', () => {
      expect(formatCombo('mod+alt+t', true)).toBe('⌘⌥T');
    });
    it('mod+ArrowUp → ⌘↑', () => {
      expect(formatCombo('mod+ArrowUp', true)).toBe('⌘↑');
    });
    it('mod+, → ⌘,', () => {
      expect(formatCombo('mod+,', true)).toBe('⌘,');
    });
    it('mod+\\ → ⌘\\', () => {
      expect(formatCombo('mod+\\', true)).toBe('⌘\\');
    });
  });

  describe('non-mac', () => {
    it('mod+d → Ctrl+D', () => {
      expect(formatCombo('mod+d', false)).toBe('Ctrl+D');
    });
    it('mod+shift+[ → Ctrl+Shift+[', () => {
      expect(formatCombo('mod+shift+[', false)).toBe('Ctrl+Shift+[');
    });
    it('mod+ArrowDown → Ctrl+↓', () => {
      expect(formatCombo('mod+ArrowDown', false)).toBe('Ctrl+↓');
    });
  });

  it('preserves multi-char keys without uppercasing', () => {
    expect(formatCombo('mod+Enter', true)).toBe('⌘Enter');
  });
});

describe('tooltipWithShortcut', () => {
  it('appends formatted combo when present', () => {
    expect(tooltipWithShortcut('Settings', 'mod+,', true)).toBe('Settings (⌘,)');
    expect(tooltipWithShortcut('Settings', 'mod+,', false)).toBe('Settings (Ctrl+,)');
  });

  it('returns plain label when combo is undefined', () => {
    expect(tooltipWithShortcut('New project', undefined, true)).toBe('New project');
  });

  it('returns plain label when combo is empty string', () => {
    expect(tooltipWithShortcut('Action', '', true)).toBe('Action');
  });
});
