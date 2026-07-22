import { useEffect, useRef } from 'react';
import type { SlashCommand } from './slash-commands';

interface Props {
  commands: SlashCommand[];
  selection: number;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}

/** Slash-command autocomplete dropdown. Rendered only when open + non-empty;
 *  the parent owns open/selection state and the actual dispatch. The container
 *  scrolls (CSS max-height + overflow-y); render ALL matches and keep the
 *  keyboard-selected row scrolled into view (long lists — e.g. ACP's 32
 *  commands — overflow the fold). */
export function SlashMenu({ commands, selection, onSelect, onHover }: Props) {
  const selectedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selection]);
  return (
    <div className="agent-slash-menu">
      {commands.map((cmd, i) => (
        <div
          key={cmd.name}
          ref={i === selection ? selectedRef : undefined}
          className={`agent-slash-item${i === selection ? ' agent-slash-item-selected' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); onSelect(cmd); }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="agent-slash-name">/{cmd.name}</span>
          <span className="agent-slash-desc">{cmd.description}</span>
        </div>
      ))}
    </div>
  );
}
