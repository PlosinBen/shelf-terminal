import { describe, it, expect } from 'vitest';
import { initialStateFor, isComplete, packAnswer, type PickerPrompt } from './PickerPanel';

/**
 * Pure-logic tests for PickerPanel state shape. Component interaction is
 * covered by E2E (step 5 of picker-request-redesign.md) — DOM-level vitest
 * would require introducing jsdom + @testing-library/react infrastructure
 * for a single component, not worth the dep weight.
 */

function makePrompt(over: Partial<PickerPrompt> = {}): PickerPrompt {
  return {
    question: 'Q?',
    multiSelect: false,
    options: [{ label: 'A' }, { label: 'B' }],
    ...over,
  };
}

describe('initialStateFor', () => {
  it('returns empty state when no currentValue', () => {
    expect(initialStateFor(makePrompt())).toEqual({ selected: [], input: '' });
  });

  it('seeds single-select from string currentValue', () => {
    const p = makePrompt({ currentValue: 'A' });
    expect(initialStateFor(p)).toEqual({ selected: ['A'], input: '' });
  });

  it('seeds multi-select from string[] currentValue (copy)', () => {
    const seed = ['A', 'B'];
    const p = makePrompt({ multiSelect: true, currentValue: seed });
    const state = initialStateFor(p);
    expect(state.selected).toEqual(['A', 'B']);
    // Must be a copy — mutating state shouldn't bleed into the prompt source.
    state.selected.push('C');
    expect(seed).toEqual(['A', 'B']);
  });

  it('treats empty string currentValue as unset', () => {
    const p = makePrompt({ currentValue: '' });
    expect(initialStateFor(p)).toEqual({ selected: [], input: '' });
  });
});

describe('isComplete', () => {
  it('is false with nothing selected and no input', () => {
    const p = makePrompt();
    expect(isComplete(p, { selected: [], input: '' })).toBe(false);
  });

  it('is true with any picked option', () => {
    const p = makePrompt();
    expect(isComplete(p, { selected: ['A'], input: '' })).toBe(true);
  });

  it('input alone counts when inputType is set (no option needed)', () => {
    const p = makePrompt({ inputType: 'text' });
    expect(isComplete(p, { selected: [], input: 'custom' })).toBe(true);
  });

  it('input alone with only whitespace is not complete', () => {
    const p = makePrompt({ inputType: 'text' });
    expect(isComplete(p, { selected: [], input: '   \t  ' })).toBe(false);
  });

  it('input ignored when inputType is not set', () => {
    const p = makePrompt();  // no inputType
    // Even if state.input has content, without inputType the user cannot
    // have actually typed it (no input field rendered). Belt-and-braces:
    // the completeness check ignores it.
    expect(isComplete(p, { selected: [], input: 'stray' })).toBe(false);
  });

  it('multi-select with input alone is complete (no option required)', () => {
    const multi = makePrompt({ multiSelect: true, inputType: 'text' });
    expect(isComplete(multi, { selected: [], input: 'x' })).toBe(true);
  });
});

describe('packAnswer', () => {
  it('single-select returns the picked label as string', () => {
    const p = makePrompt();
    expect(packAnswer(p, { selected: ['A'], input: '' })).toBe('A');
  });

  it('single-select with no selection returns empty string', () => {
    const p = makePrompt();
    expect(packAnswer(p, { selected: [], input: '' })).toBe('');
  });

  it('single-select prefers input over picked option when input is non-empty', () => {
    // User picked A but then typed "custom" — typed answer wins (AskUserQuestion
    // Other semantics + Copilot session.ui.input() where options=[]).
    const p = makePrompt({ inputType: 'text' });
    expect(packAnswer(p, { selected: ['A'], input: 'custom' })).toBe('custom');
  });

  it('single-select trims whitespace from input value', () => {
    const p = makePrompt({ inputType: 'text' });
    expect(packAnswer(p, { selected: [], input: '  custom  ' })).toBe('custom');
  });

  it('single-select input ignored when inputType is not set', () => {
    const p = makePrompt();
    expect(packAnswer(p, { selected: ['A'], input: 'stray' })).toBe('A');
  });

  it('multi-select returns selected labels as string[]', () => {
    const p = makePrompt({ multiSelect: true });
    expect(packAnswer(p, { selected: ['A', 'B'], input: '' })).toEqual(['A', 'B']);
  });

  it('multi-select appends input value when non-empty', () => {
    const p = makePrompt({ multiSelect: true, inputType: 'text' });
    expect(packAnswer(p, { selected: ['A'], input: 'custom' })).toEqual(['A', 'custom']);
  });

  it('multi-select returns just input when no options selected', () => {
    const p = makePrompt({ multiSelect: true, inputType: 'text' });
    expect(packAnswer(p, { selected: [], input: 'custom' })).toEqual(['custom']);
  });
});
