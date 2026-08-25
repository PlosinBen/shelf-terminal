import React, { useEffect, useState } from 'react';

/**
 * Generic selection panel anchored above the agent input bar. Used for
 * permission prompts (allow once / allow for session / deny) and for any
 * provider-emitted picker request (model picker, future effort/perm-mode
 * pickers).
 *
 * One panel rendered at a time per AgentView — render the higher-priority
 * one when both permission and picker want to display (see AgentView for
 * the priority gate). Internal state owns the keyboard cursor.
 *
 * CSS classes are shared with the legacy permission popup so the visual
 * language stays consistent (`agent-permission`, `agent-perm-option`, etc.).
 */
export interface SelectionOption {
  value: string;
  label: string;
  /**
   * Color hint. `allow` (green-ish) is also the neutral default for
   * non-binary pickers. `deny` (red-ish) marks destructive choices like the
   * Deny button on permission prompts. Renderer maps via CSS class.
   */
  kind?: 'allow' | 'deny';
}

export interface SelectionPanelProps {
  title: React.ReactNode;
  /** Optional description block shown between title and options (e.g. tool input JSON for permission). */
  description?: React.ReactNode;
  options: SelectionOption[];
  /** If true, Escape cancels (calls onCancel). Default false — permission prompts must be resolved. */
  cancellable?: boolean;
  /** Initial cursor position (default 0). */
  initialSelected?: number;
  /** Hint footer (e.g. "↑↓ select · Enter confirm · Esc cancel"). Auto-generated if not provided. */
  hint?: React.ReactNode;
  onSelect: (value: string) => void;
  onCancel?: () => void;
}

export type SelectionKeyDecision =
  | { kind: 'move'; index: number }
  | { kind: 'select'; index: number }
  | { kind: 'cancel' }
  | { kind: 'ignore' };

export function decideSelectionKey(
  key: string,
  selected: number,
  optionCount: number,
  cancellable: boolean,
  isComposing: boolean,
): SelectionKeyDecision {
  if (isComposing || optionCount === 0) return { kind: 'ignore' };
  if (key === 'ArrowUp') {
    return { kind: 'move', index: selected > 0 ? selected - 1 : optionCount - 1 };
  }
  if (key === 'ArrowDown') {
    return { kind: 'move', index: selected < optionCount - 1 ? selected + 1 : 0 };
  }
  if (key === 'Enter') return { kind: 'select', index: selected };
  if (key === 'Escape' && cancellable) return { kind: 'cancel' };
  return { kind: 'ignore' };
}

export function SelectionPanel({
  title,
  description,
  options,
  cancellable = false,
  initialSelected = 0,
  hint,
  onSelect,
  onCancel,
}: SelectionPanelProps) {
  const [selected, setSelected] = useState(
    initialSelected >= 0 && initialSelected < options.length ? initialSelected : 0,
  );

  useEffect(() => {
    if (options.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      const decision = decideSelectionKey(e.key, selected, options.length, cancellable, e.isComposing);
      if (decision.kind === 'ignore') return;
      e.preventDefault();
      if (decision.kind === 'move') setSelected(decision.index);
      else if (decision.kind === 'cancel') onCancel?.();
      else {
        const option = options[decision.index];
        if (option) onSelect(option.value);
      }
    };
    // Capture phase so we beat xterm / global combo handlers that consume keys.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [options, selected, cancellable, onSelect, onCancel]);

  const defaultHint = (
    <>
      <kbd>↑</kbd><kbd>↓</kbd> select · <kbd>Enter</kbd> confirm
      {cancellable && <> · <kbd>Esc</kbd> cancel</>}
    </>
  );

  return (
    <div className="agent-permission">
      <div className="agent-permission-header">{title}</div>
      {description && <div className="agent-permission-input">{description}</div>}
      <div className="agent-perm-options">
        {options.map((opt, i) => {
          const kindCls = `agent-perm-option-${opt.kind ?? 'allow'}`;
          const selCls = selected === i ? ' selected' : '';
          return (
            <div
              key={opt.value}
              className={`agent-perm-option ${kindCls}${selCls}`}
              onClick={() => onSelect(opt.value)}
            >
              <span className="agent-perm-indicator">{selected === i ? '▶' : ' '}</span>
              <span>{opt.label}</span>
            </div>
          );
        })}
      </div>
      <div className="agent-perm-hint">{hint ?? defaultHint}</div>
    </div>
  );
}
