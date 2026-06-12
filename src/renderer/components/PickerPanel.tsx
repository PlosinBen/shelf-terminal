import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * PickerPanel — multi-question structured form anchored above the agent
 * input bar.
 *
 * Renders ONE question at a time (1-4 questions per request) with
 * back / next / submit navigation. Each question independently supports
 * single-select, multi-select, and an optional free-text "Other" option
 * driven by the prompt's `inputType` field.
 *
 * Shares the bottom-panel visual language with `<SelectionPanel>` (permission
 * popup) via the `agent-permission` / `agent-perm-*` CSS family.
 *
 * Wire shape comes from `agent-server/providers/types.ts` PickerRequest;
 * design rationale lives in DECISIONS #57.
 *
 * Producer-side: Claude AskUserQuestion intercept (claude.ts canUseTool
 * branch) and Copilot elicitation handler both emit picker_request
 * through this component.
 */

export interface PickerPromptOption {
  label: string;
  description?: string;
  /** Optional preview content — v1 doesn't render this, kept on the wire
   *  for a future renderer (see DECISIONS #57 "Out of scope"). */
  preview?: string;
}

export interface PickerPrompt {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: PickerPromptOption[];
  /** When set, an "Other" option appears at the end of the options list;
   *  selecting it surfaces a free-text input (typed per inputType). */
  inputType?: 'text' | 'number' | 'integer';
  currentValue?: string | string[];
}

export interface PickerPanelProps {
  prompts: PickerPrompt[];
  /** Submitted answers are index-aligned with `prompts`. Single-select returns
   *  a `string` (option label or free-text content); multi-select returns a
   *  `string[]`. */
  onSubmit: (answers: Array<string | string[]>) => void;
  onCancel: () => void;
}

export interface PromptState {
  /** Selected option labels (single-select: 0-or-1 entry; multi: any). */
  selected: string[];
  /** Free-text / numeric input contents. Meaningful only when the prompt
   *  has `inputType` set. Independent of `selected` — fills count toward
   *  completeness on their own. */
  input: string;
}

export function initialStateFor(prompt: PickerPrompt): PromptState {
  // Seed from currentValue when provided. Multi-select: array of labels.
  // Single-select: a single label string.
  if (Array.isArray(prompt.currentValue)) {
    return { selected: [...prompt.currentValue], input: '' };
  }
  if (typeof prompt.currentValue === 'string' && prompt.currentValue.length > 0) {
    return { selected: [prompt.currentValue], input: '' };
  }
  return { selected: [], input: '' };
}

export function isComplete(prompt: PickerPrompt, state: PromptState): boolean {
  // Every prompt is required — optional-aware UI is YAGNI (DECISIONS #57
  // out-of-scope). A prompt is satisfied as long as the user provides
  // SOME answer: a picked option OR a non-empty free-text input (when
  // inputType is set). Both pathways count equally.
  if (state.selected.length > 0) return true;
  if (prompt.inputType && state.input.trim() !== '') return true;
  return false;
}

/** Translate prompt + state into the answer slot for onSubmit.
 *
 * Rules:
 *   single-select: prefer a non-empty input value (covers Copilot
 *     `session.ui.input()` where options=[] / inputType set, and the
 *     "Other" semantics from AskUserQuestion where the user types
 *     something instead of picking a listed option). Otherwise fall back
 *     to the picked option label.
 *   multi-select: array of picked option labels + the input value
 *     appended when non-empty.
 */
export function packAnswer(prompt: PickerPrompt, state: PromptState): string | string[] {
  const inputValue = state.input.trim();
  const hasInput = prompt.inputType !== undefined && inputValue !== '';
  if (prompt.multiSelect) {
    return hasInput ? [...state.selected, inputValue] : [...state.selected];
  }
  if (hasInput) return inputValue;
  return state.selected[0] ?? '';
}

/** A keyboard intent, decided purely from the event + current panel context.
 *  The component maps it to side effects (preventDefault, focus moves, submit). */
export type PickerKeyAction =
  | { type: 'none' }
  | { type: 'cancel' }
  | { type: 'navigate'; direction: 'up' | 'down' }
  | { type: 'submit' }
  | { type: 'toggle' };

export interface PickerKeyContext {
  key: string;
  /** True mid-IME-composition (CJK candidate selection). */
  isComposing: boolean;
  /** True when the free-text input owns focus. */
  inputFocused: boolean;
  hasOptions: boolean;
  currentComplete: boolean;
}

/**
 * Decide what a keydown means for the picker. Pure so the IME / navigation
 * rules are unit-testable (component DOM wiring stays a thin adapter).
 *
 *   IME first  — while composing, arrows/Enter/Esc drive the candidate window;
 *                hijacking them for option nav or submit eats the user's CJK
 *                character pick. Defer to the IME for EVERY key (return none).
 *   ↑/↓        — move the option cursor (the adapter wraps + blurs the input).
 *   Enter      — advance/submit, only when the current prompt is complete.
 *   Space      — toggle the focused option, but not while typing in the input
 *                (so spaces can be typed) and only when options exist.
 *   Esc        — cancel the whole picker.
 */
export function decidePickerKey(ctx: PickerKeyContext): PickerKeyAction {
  if (ctx.isComposing) return { type: 'none' };
  if (ctx.key === 'Escape') return { type: 'cancel' };
  if (ctx.key === 'ArrowUp' || ctx.key === 'ArrowDown') {
    if (!ctx.hasOptions) return { type: 'none' };
    return { type: 'navigate', direction: ctx.key === 'ArrowUp' ? 'up' : 'down' };
  }
  if (ctx.key === 'Enter') {
    if (!ctx.currentComplete) return { type: 'none' };
    return { type: 'submit' };
  }
  if (ctx.key === ' ' || ctx.key === 'Spacebar') {
    if (ctx.inputFocused || !ctx.hasOptions) return { type: 'none' };
    return { type: 'toggle' };
  }
  return { type: 'none' };
}

export function PickerPanel({ prompts, onSubmit, onCancel }: PickerPanelProps) {
  // One state slot per prompt — initialized once. We do NOT reset state when
  // the user navigates back/forward; their prior answers stay editable.
  const [states, setStates] = useState<PromptState[]>(() => prompts.map(initialStateFor));
  const [index, setIndex] = useState(0);
  // Keyboard cursor within the current prompt's option list. Resets when the
  // user navigates between prompts.
  const [focusedIdx, setFocusedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset focused option when stepping to a new prompt.
  useEffect(() => { setFocusedIdx(0); }, [index]);

  const currentPrompt = prompts[index];
  const currentState = states[index];

  const totalSteps = prompts.length;
  const isLast = index === totalSteps - 1;

  const currentComplete = currentPrompt ? isComplete(currentPrompt, currentState) : false;
  const allComplete = useMemo(
    () => prompts.every((p, i) => isComplete(p, states[i])),
    [prompts, states],
  );

  const setCurrent = useCallback((updater: (s: PromptState) => PromptState) => {
    setStates((prev) => prev.map((s, i) => (i === index ? updater(s) : s)));
  }, [index]);

  const toggleOption = useCallback((label: string) => {
    if (!currentPrompt) return;
    if (currentPrompt.multiSelect) {
      setCurrent((s) => ({
        ...s,
        selected: s.selected.includes(label)
          ? s.selected.filter((x) => x !== label)
          : [...s.selected, label],
      }));
    } else {
      setCurrent((s) => ({ ...s, selected: [label] }));
    }
  }, [currentPrompt, setCurrent]);

  const setInput = useCallback((value: string) => {
    setCurrent((s) => ({ ...s, input: value }));
  }, [setCurrent]);

  const goNext = useCallback(() => {
    if (!currentComplete) return;
    if (isLast) {
      if (!allComplete) return;
      onSubmit(prompts.map((p, i) => packAnswer(p, states[i])));
    } else {
      setIndex((i) => i + 1);
    }
  }, [currentComplete, isLast, allComplete, onSubmit, prompts, states]);

  const goBack = useCallback(() => {
    if (index > 0) setIndex((i) => i - 1);
  }, [index]);

  // Option list (no synthetic "Other" — free-text input is rendered
  // separately below, always visible when inputType is set).
  const renderedOptions: Array<PickerPromptOption & { value: string }> = currentPrompt
    ? currentPrompt.options.map((o) => ({ ...o, value: o.label }))
    : [];

  // Keep cursor in bounds when option count changes (between prompts).
  useEffect(() => {
    if (focusedIdx >= renderedOptions.length && renderedOptions.length > 0) {
      setFocusedIdx(0);
    }
  }, [focusedIdx, renderedOptions.length]);

  // Keyboard intents are decided by the pure `decidePickerKey` (see its doc for
  // the IME / nav / submit rules); this effect is the thin adapter that applies
  // the chosen action's side effects. ↑/↓ blur the input so the user can step
  // away from the free-text field onto the options without clicking out (the
  // caret trade-off only applies once they've left composition).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inputFocused = document.activeElement === inputRef.current;
      const action = decidePickerKey({
        key: e.key,
        isComposing: e.isComposing,
        inputFocused,
        hasOptions: renderedOptions.length > 0,
        currentComplete,
      });
      switch (action.type) {
        case 'cancel':
          e.preventDefault();
          onCancel();
          break;
        case 'navigate': {
          e.preventDefault();
          if (inputFocused) inputRef.current?.blur();
          const max = renderedOptions.length - 1;
          setFocusedIdx((p) => action.direction === 'up'
            ? (p > 0 ? p - 1 : max)
            : (p < max ? p + 1 : 0));
          break;
        }
        case 'submit':
          e.preventDefault();
          goNext();
          break;
        case 'toggle': {
          e.preventDefault();
          const opt = renderedOptions[focusedIdx];
          if (opt) toggleOption(opt.value);
          break;
        }
        default:
          break;
      }
    };
    // Capture phase so we beat xterm / global combo handlers that consume keys.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onCancel, goNext, currentComplete, focusedIdx, renderedOptions, toggleOption]);

  if (!currentPrompt) return null;

  const inputHtmlType = currentPrompt.inputType === 'number' || currentPrompt.inputType === 'integer'
    ? 'number'
    : 'text';
  const inputStep = currentPrompt.inputType === 'integer' ? '1' : undefined;

  return (
    <div className="agent-permission picker-panel">
      <div className="agent-permission-header">
        {currentPrompt.header && (
          <span className="picker-header-chip">{currentPrompt.header}</span>
        )}
        <span className="picker-question">{currentPrompt.question}</span>
      </div>
      {totalSteps > 1 && (
        <div className="picker-progress">
          Question {index + 1} of {totalSteps}
        </div>
      )}
      <div className="agent-perm-options picker-options">
        {renderedOptions.map((opt, i) => {
          const checked = currentState.selected.includes(opt.value);
          const focused = focusedIdx === i;
          const role = currentPrompt.multiSelect ? 'checkbox' : 'radio';
          const marker = currentPrompt.multiSelect
            ? (checked ? '☑' : '☐')
            : (checked ? '◉' : '○');
          return (
            <button
              key={opt.value}
              type="button"
              role={role}
              aria-checked={checked}
              className={`agent-perm-option picker-option${checked ? ' selected' : ''}${focused ? ' focused' : ''}`}
              onClick={() => { setFocusedIdx(i); toggleOption(opt.value); }}
            >
              <span className="agent-perm-indicator">{marker}</span>
              <span className="picker-option-label">{opt.label}</span>
              {opt.description && (
                <span className="picker-option-desc">{opt.description}</span>
              )}
            </button>
          );
        })}
      </div>
      {currentPrompt.inputType && (
        // Always-visible free-text / numeric input. The user can type here
        // without first picking an "Other" option — non-empty content counts
        // as a valid answer on its own (covers Copilot session.ui.input
        // where options=[] / inputType set, and AskUserQuestion's implicit
        // Other affordance). isComplete() and packAnswer() treat input as
        // an OR-pathway alongside picked options.
        <div className="picker-input-row">
          <label className="picker-input-label">
            {renderedOptions.length > 0 ? 'Or type your own:' : 'Your answer:'}
          </label>
          <input
            ref={inputRef}
            type={inputHtmlType}
            step={inputStep}
            className="picker-other-input"
            value={currentState.input}
            placeholder={
              currentPrompt.inputType === 'number' || currentPrompt.inputType === 'integer'
                ? 'Enter a number'
                : 'Enter your answer'
            }
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
      )}
      <div className="picker-actions">
        <button type="button" className="picker-btn" onClick={onCancel}>
          Cancel
        </button>
        {index > 0 && (
          <button type="button" className="picker-btn" onClick={goBack}>
            Back
          </button>
        )}
        <button
          type="button"
          className="picker-btn picker-btn-primary"
          disabled={isLast ? !allComplete : !currentComplete}
          onClick={goNext}
        >
          {isLast ? 'Submit' : 'Next'}
        </button>
      </div>
      <div className="agent-perm-hint">
        <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Space</kbd> {currentPrompt.multiSelect ? 'toggle' : 'pick'} · <kbd>Enter</kbd> {isLast ? 'submit' : 'next'} · <kbd>Esc</kbd> cancel
      </div>
    </div>
  );
}
