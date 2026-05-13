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
 * Wire shape comes from `agent-server/providers/types.ts` PickerRequest —
 * see `.agent/features/picker-request-redesign.md` for the protocol.
 *
 * Producer-side: Claude AskUserQuestion intercept (claude.ts canUseTool
 * branch) and Copilot elicitation handler (forthcoming) both emit
 * picker_request through this component.
 */

export interface PickerPromptOption {
  label: string;
  description?: string;
  /** Optional preview content — v1 doesn't render this, kept for v2 (see
   *  picker-request-redesign.md "Out of scope v1"). */
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

/** Sentinel string to identify the synthetic "Other" option distinct from any
 *  agent-supplied label. Internal-only — never escapes `packAnswer` (we
 *  replace it with the user's free-text input before submit). */
export const OTHER_SENTINEL = '__picker_other__';

export interface PromptState {
  /** Selected option labels (single-select: 0-or-1 entry; multi: any). May
   *  include OTHER_SENTINEL if the prompt has an inputType and the user
   *  chose "Other". */
  selected: string[];
  /** Current free-text input value. Only meaningful when OTHER_SENTINEL is
   *  in `selected`. */
  freeText: string;
}

export function initialStateFor(prompt: PickerPrompt): PromptState {
  // Seed from currentValue when provided. Multi-select: array of labels.
  // Single-select: a single label string.
  if (Array.isArray(prompt.currentValue)) {
    return { selected: [...prompt.currentValue], freeText: '' };
  }
  if (typeof prompt.currentValue === 'string' && prompt.currentValue.length > 0) {
    return { selected: [prompt.currentValue], freeText: '' };
  }
  return { selected: [], freeText: '' };
}

export function isComplete(prompt: PickerPrompt, state: PromptState): boolean {
  // Every prompt is required (see picker-request-redesign.md "Out of scope
  // v1" — optional-aware UI is YAGNI for now).
  if (state.selected.length === 0) return false;
  // "Other" must have a non-empty free-text body to count as answered.
  if (state.selected.includes(OTHER_SENTINEL) && state.freeText.trim() === '') return false;
  return true;
}

/** Translate prompt + state into the answer slot for onSubmit. */
export function packAnswer(prompt: PickerPrompt, state: PromptState): string | string[] {
  const resolved = state.selected.map((s) => (s === OTHER_SENTINEL ? state.freeText : s));
  if (prompt.multiSelect) return resolved;
  // Single-select: take the first (state should hold at most one when single).
  return resolved[0] ?? '';
}

export function PickerPanel({ prompts, onSubmit, onCancel }: PickerPanelProps) {
  // One state slot per prompt — initialized once. We do NOT reset state when
  // the user navigates back/forward; their prior answers stay editable.
  const [states, setStates] = useState<PromptState[]>(() => prompts.map(initialStateFor));
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
      setCurrent((s) => {
        const next = s.selected.includes(label)
          ? s.selected.filter((x) => x !== label)
          : [...s.selected, label];
        // Reset freeText when "Other" gets unchecked so stale text doesn't
        // resurface if the user toggles it back on.
        const nextFreeText = next.includes(OTHER_SENTINEL) ? s.freeText : '';
        return { selected: next, freeText: nextFreeText };
      });
    } else {
      setCurrent((s) => {
        const nextSelected = [label];
        const nextFreeText = label === OTHER_SENTINEL ? s.freeText : '';
        return { selected: nextSelected, freeText: nextFreeText };
      });
    }
  }, [currentPrompt, setCurrent]);

  const setFreeText = useCallback((value: string) => {
    setCurrent((s) => ({ ...s, freeText: value }));
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

  // Auto-focus the free-text input when "Other" gets selected, so the user
  // can start typing without an extra Tab.
  useEffect(() => {
    if (currentState?.selected.includes(OTHER_SENTINEL)) {
      inputRef.current?.focus();
    }
  }, [currentState?.selected]);

  // Keyboard: Esc cancels, Enter advances when actionable. Arrow keys are
  // intentionally NOT bound — multi-select + free-text combos make a single
  // cursor confusing. Users click options (or Tab through them — buttons
  // get native focus).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === 'Enter') {
        // Don't hijack Enter when the free-text input is focused (would
        // submit prematurely when the user just hit Enter inside the field).
        const active = document.activeElement;
        if (active === inputRef.current) return;
        if (!currentComplete) return;
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onCancel, goNext, currentComplete]);

  if (!currentPrompt) return null;

  // Build the option list with "Other" appended when inputType is configured.
  const renderedOptions: Array<PickerPromptOption & { value: string; isOther?: boolean }> = [
    ...currentPrompt.options.map((o) => ({ ...o, value: o.label })),
  ];
  if (currentPrompt.inputType) {
    renderedOptions.push({ label: 'Other', value: OTHER_SENTINEL, isOther: true });
  }

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
        {renderedOptions.map((opt) => {
          const checked = currentState.selected.includes(opt.value);
          const role = currentPrompt.multiSelect ? 'checkbox' : 'radio';
          const marker = currentPrompt.multiSelect
            ? (checked ? '☑' : '☐')
            : (checked ? '◉' : '○');
          return (
            <div key={opt.value} className="picker-option-row">
              <button
                type="button"
                role={role}
                aria-checked={checked}
                className={`agent-perm-option picker-option${checked ? ' selected' : ''}`}
                onClick={() => toggleOption(opt.value)}
              >
                <span className="agent-perm-indicator">{marker}</span>
                <span className="picker-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="picker-option-desc">{opt.description}</span>
                )}
              </button>
              {opt.isOther && checked && (
                <input
                  ref={inputRef}
                  type={inputHtmlType}
                  step={inputStep}
                  className="picker-other-input"
                  value={currentState.freeText}
                  placeholder={currentPrompt.inputType === 'number' || currentPrompt.inputType === 'integer' ? 'Enter a number' : 'Enter your answer'}
                  onChange={(e) => setFreeText(e.target.value)}
                />
              )}
            </div>
          );
        })}
      </div>
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
        <kbd>Enter</kbd> {isLast ? 'submit' : 'next'} · <kbd>Esc</kbd> cancel
      </div>
    </div>
  );
}
