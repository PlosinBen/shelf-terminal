import React from 'react';

interface Props {
  currentPath: string;
  filtered: string[];
  selectedIndex: number;
  filter: string;
  loading: boolean;
  error: string | null;
  listRef: React.RefObject<HTMLDivElement | null>;
  onSelectIndex: (index: number) => void;
  onNavigate: (path: string) => void;
  onGoUp: () => void;
}

export function FolderBrowser({
  currentPath, filtered, selectedIndex, filter, loading, error,
  listRef, onSelectIndex, onNavigate, onGoUp,
}: Props) {
  return (
    <div className="fp-browser">
      {loading && <div className="fp-browser-loading-overlay">Loading...</div>}

      <div className="fp-browser-header">
        <div className="fp-browser-path">
          {filtered[selectedIndex] ? `${currentPath}/${filtered[selectedIndex]}` : currentPath}
        </div>
      </div>

      <div className="fp-browser-filter">
        {filter || <span className="fp-browser-filter-placeholder">Type to filter...</span>}
      </div>

      {error && <div className="fp-browser-error">{error}</div>}

      <div className="fp-browser-list" ref={listRef}>
        <div
          className={`folder-picker-item${selectedIndex === -1 ? ' selected' : ''}`}
          onClick={() => onSelectIndex(-1)}
          onDoubleClick={onGoUp}
        >
          <span className="folder-picker-item-icon">{'\u2190'}</span>
          <span className="folder-picker-item-name">..</span>
        </div>

        {filtered.length === 0 ? (
          <div className="fp-browser-empty">
            {filter ? 'No matches' : 'No subdirectories'}
          </div>
        ) : (
          filtered.map((name, i) => (
            <div
              key={name}
              className={`folder-picker-item${i === selectedIndex ? ' selected' : ''}`}
              onClick={() => onSelectIndex(i)}
              onDoubleClick={() => onNavigate(currentPath + '/' + name)}
            >
              <span className="folder-picker-item-icon">{'\uD83D\uDCC1'}</span>
              <span className="folder-picker-item-name">{name}</span>
            </div>
          ))
        )}
      </div>

      <div className="fp-browser-footer">
        <div className="fp-browser-hints">
          <span className="fp-hint"><kbd>{'\u2191\u2193'}</kbd> select</span>
          <span className="fp-hint"><kbd>{'\u2192'}</kbd> enter</span>
          <span className="fp-hint"><kbd>{'\u2190'}</kbd> up</span>
          <span className="fp-hint"><kbd>Enter</kbd> confirm</span>
          <span className="fp-hint"><kbd>Esc</kbd> cancel</span>
        </div>
      </div>
    </div>
  );
}
