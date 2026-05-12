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
    const max = options.length - 1;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((p) => (p > 0 ? p - 1 : max));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((p) => (p < max ? p + 1 : 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const opt = options[selected];
        if (opt) onSelect(opt.value);
      } else if (e.key === 'Escape' && cancellable) {
        e.preventDefault();
        onCancel?.();
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
