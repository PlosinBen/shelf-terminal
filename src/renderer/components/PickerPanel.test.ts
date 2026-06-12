import { describe, it, expect } from 'vitest';
import {
  initialStateFor, isComplete, packAnswer, decidePickerKey,
  type PickerPrompt, type PickerKeyContext,
} from './PickerPanel';

/**
 * Pure-logic tests for PickerPanel state shape. Component interaction
 * (rendering, clicks, keyboard) is deferred to E2E — DOM-level vitest
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

describe('decidePickerKey', () => {
  const base: PickerKeyContext = {
    key: '', isComposing: false, inputFocused: false, hasOptions: true, currentComplete: true,
  };
  const ctx = (over: Partial<PickerKeyContext>): PickerKeyContext => ({ ...base, ...over });

  // ── Regression: IME composition must win over option navigation ──
  // Typing CJK in the free-text input and pressing ↑/↓ to pick a candidate was
  // hijacked into switching options (and blurring the input) — can't choose a
  // character. While composing, EVERY key defers to the IME.
  it('arrows during IME composition → none (do not switch options)', () => {
    expect(decidePickerKey(ctx({ key: 'ArrowDown', isComposing: true, inputFocused: true }))).toEqual({ type: 'none' });
    expect(decidePickerKey(ctx({ key: 'ArrowUp', isComposing: true, inputFocused: true }))).toEqual({ type: 'none' });
  });
  it('Enter / Space / Esc during composition → none (IME commit / candidate keys)', () => {
    expect(decidePickerKey(ctx({ key: 'Enter', isComposing: true }))).toEqual({ type: 'none' });
    expect(decidePickerKey(ctx({ key: ' ', isComposing: true }))).toEqual({ type: 'none' });
    expect(decidePickerKey(ctx({ key: 'Escape', isComposing: true }))).toEqual({ type: 'none' });
  });

  // ── Normal (not composing) behavior is preserved ──
  it('arrows navigate when options exist', () => {
    expect(decidePickerKey(ctx({ key: 'ArrowUp' }))).toEqual({ type: 'navigate', direction: 'up' });
    expect(decidePickerKey(ctx({ key: 'ArrowDown' }))).toEqual({ type: 'navigate', direction: 'down' });
  });
  it('arrows do nothing when there are no options', () => {
    expect(decidePickerKey(ctx({ key: 'ArrowDown', hasOptions: false }))).toEqual({ type: 'none' });
  });
  it('Escape cancels', () => {
    expect(decidePickerKey(ctx({ key: 'Escape' }))).toEqual({ type: 'cancel' });
  });
  it('Enter submits only when complete', () => {
    expect(decidePickerKey(ctx({ key: 'Enter', currentComplete: true }))).toEqual({ type: 'submit' });
    expect(decidePickerKey(ctx({ key: 'Enter', currentComplete: false }))).toEqual({ type: 'none' });
  });
  it('Space toggles, except while typing in the input or with no options', () => {
    expect(decidePickerKey(ctx({ key: ' ' }))).toEqual({ type: 'toggle' });
    expect(decidePickerKey(ctx({ key: ' ', inputFocused: true }))).toEqual({ type: 'none' });
    expect(decidePickerKey(ctx({ key: ' ', hasOptions: false }))).toEqual({ type: 'none' });
  });
});
