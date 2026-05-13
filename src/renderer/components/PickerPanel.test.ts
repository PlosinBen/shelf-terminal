import { describe, it, expect } from 'vitest';
import { initialStateFor, isComplete, packAnswer, OTHER_SENTINEL, type PickerPrompt } from './PickerPanel';

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
    expect(initialStateFor(makePrompt())).toEqual({ selected: [], freeText: '' });
  });

  it('seeds single-select from string currentValue', () => {
    const p = makePrompt({ currentValue: 'A' });
    expect(initialStateFor(p)).toEqual({ selected: ['A'], freeText: '' });
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
    expect(initialStateFor(p)).toEqual({ selected: [], freeText: '' });
  });
});

describe('isComplete', () => {
  const prompt = makePrompt();

  it('is false with no selection', () => {
    expect(isComplete(prompt, { selected: [], freeText: '' })).toBe(false);
  });

  it('is true with any non-Other selection', () => {
    expect(isComplete(prompt, { selected: ['A'], freeText: '' })).toBe(true);
  });

  it('is false when Other is selected but freeText is empty', () => {
    expect(isComplete(prompt, { selected: [OTHER_SENTINEL], freeText: '' })).toBe(false);
  });

  it('is false when Other freeText is whitespace only', () => {
    expect(isComplete(prompt, { selected: [OTHER_SENTINEL], freeText: '   \t  ' })).toBe(false);
  });

  it('is true when Other selected with non-empty freeText', () => {
    expect(isComplete(prompt, { selected: [OTHER_SENTINEL], freeText: 'custom' })).toBe(true);
  });

  it('multi-select with Other requires freeText alongside other picks', () => {
    const multi = makePrompt({ multiSelect: true });
    expect(isComplete(multi, { selected: ['A', OTHER_SENTINEL], freeText: '' })).toBe(false);
    expect(isComplete(multi, { selected: ['A', OTHER_SENTINEL], freeText: 'x' })).toBe(true);
  });
});

describe('packAnswer', () => {
  it('single-select returns the picked label as string', () => {
    const p = makePrompt();
    expect(packAnswer(p, { selected: ['A'], freeText: '' })).toBe('A');
  });

  it('single-select empty selection returns empty string', () => {
    const p = makePrompt();
    expect(packAnswer(p, { selected: [], freeText: '' })).toBe('');
  });

  it('multi-select returns selected labels as string[]', () => {
    const p = makePrompt({ multiSelect: true });
    expect(packAnswer(p, { selected: ['A', 'B'], freeText: '' })).toEqual(['A', 'B']);
  });

  it('substitutes Other sentinel with freeText value (single)', () => {
    const p = makePrompt();
    expect(packAnswer(p, { selected: [OTHER_SENTINEL], freeText: 'custom' })).toBe('custom');
  });

  it('substitutes Other sentinel with freeText value (multi, mixed with options)', () => {
    const p = makePrompt({ multiSelect: true });
    const answer = packAnswer(p, { selected: ['A', OTHER_SENTINEL], freeText: 'custom' });
    expect(answer).toEqual(['A', 'custom']);
  });
});
