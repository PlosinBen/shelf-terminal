// Pure formatter for keybinding combos like 'mod+d' → '⌘D' (mac) / 'Ctrl+D' (others).
// Kept platform-agnostic (isMac as param) so it stays unit-testable in node env.

export function formatCombo(combo: string, isMac: boolean): string {
  return combo
    .split('+')
    .map((part) => {
      if (part === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (part === 'shift') return isMac ? '⇧' : 'Shift';
      if (part === 'alt') return isMac ? '⌥' : 'Alt';
      if (part === 'ArrowUp') return '↑';
      if (part === 'ArrowDown') return '↓';
      if (part === 'ArrowLeft') return '←';
      if (part === 'ArrowRight') return '→';
      if (part.length === 1) return part.toUpperCase();
      return part;
    })
    .join(isMac ? '' : '+');
}

export function tooltipWithShortcut(label: string, combo: string | undefined, isMac: boolean): string {
  if (!combo) return label;
  return `${label} (${formatCombo(combo, isMac)})`;
}
