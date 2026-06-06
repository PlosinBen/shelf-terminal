import type { NoteMeta, Filter } from './notes-types';

export function NotesList({
  notes, counts, filter, onFilterChange, onPick, onDeleteAllDone,
}: {
  notes: NoteMeta[];
  counts: { active: number; done: number; all: number };
  filter: Filter;
  onFilterChange: (f: Filter) => void;
  onPick: (id: string) => void;
  onDeleteAllDone: () => void;
}) {
  // Bulk-action row only surfaces when there's actually something to act on
  // — keeps the toolbar clean for Active / All filters.
  const showBulkRow = filter === 'done' && counts.done > 0;
  return (
    <>
      <div className="notes-filter-row">
        <FilterTab label="Active" count={counts.active} active={filter === 'active'} onClick={() => onFilterChange('active')} />
        <FilterTab label="Done" count={counts.done} active={filter === 'done'} onClick={() => onFilterChange('done')} />
        <FilterTab label="All" count={counts.all} active={filter === 'all'} onClick={() => onFilterChange('all')} />
      </div>
      {showBulkRow && (
        <div className="notes-bulk-row">
          <button className="notes-bulk-delete" onClick={onDeleteAllDone}>Delete all</button>
        </div>
      )}
      <div className="notes-body">
        {notes.length === 0 ? (
          <div className="notes-empty">No notes yet</div>
        ) : (
          <ul className="notes-list">
            {notes.map((n) => (
              <li
                key={n.id}
                className={`notes-list-item ${n.isDone ? 'notes-list-item-done' : ''}`}
                onClick={() => onPick(n.id)}
              >
                <span className="notes-list-title">{n.title || '(untitled)'}</span>
                <span className="notes-list-time">{relativeTime(n.updated)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function FilterTab({
  label, count, active, onClick,
}: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      className={`notes-filter-tab ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      {label} <span className="notes-filter-count">{count}</span>
    </button>
  );
}

function relativeTime(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}
