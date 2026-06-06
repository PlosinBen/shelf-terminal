import type { SlashCommand } from './slash-commands';

interface Props {
  commands: SlashCommand[];
  selection: number;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}

/** Slash-command autocomplete dropdown. Rendered only when open + non-empty;
 *  the parent owns open/selection state and the actual dispatch. */
export function SlashMenu({ commands, selection, onSelect, onHover }: Props) {
  return (
    <div className="agent-slash-menu">
      {commands.slice(0, 10).map((cmd, i) => (
        <div
          key={cmd.name}
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
