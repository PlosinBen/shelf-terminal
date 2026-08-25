import { describe, expect, it } from 'vitest';
import { decideSelectionKey } from './SelectionPanel';

describe('decideSelectionKey', () => {
  it('selects the initial option on Enter', () => {
    expect(decideSelectionKey('Enter', 0, 3, true, false)).toEqual({ kind: 'select', index: 0 });
  });

  it('maps Escape to cancel only for cancellable panels', () => {
    expect(decideSelectionKey('Escape', 0, 3, true, false)).toEqual({ kind: 'cancel' });
    expect(decideSelectionKey('Escape', 0, 3, false, false)).toEqual({ kind: 'ignore' });
  });

  it('wraps keyboard navigation through every option', () => {
    expect(decideSelectionKey('ArrowUp', 0, 3, true, false)).toEqual({ kind: 'move', index: 2 });
    expect(decideSelectionKey('ArrowDown', 2, 3, true, false)).toEqual({ kind: 'move', index: 0 });
  });

  it('does not consume keys during IME composition', () => {
    expect(decideSelectionKey('Enter', 0, 3, true, true)).toEqual({ kind: 'ignore' });
  });
});
