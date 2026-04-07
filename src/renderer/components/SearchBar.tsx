import React, { useState, useRef, useEffect } from 'react';
import { useStore, closeSearch } from '../store';
import { getSearchAddon } from './TerminalView';

export function SearchBar() {
  const { searchVisible, projects, activeProjectIndex } = useStore();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const activeProject = projects[activeProjectIndex];
  const activeTabId = activeProject?.tabs[activeProject.activeTabIndex]?.id;

  useEffect(() => {
    if (searchVisible && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [searchVisible]);

  if (!searchVisible || !activeTabId) return null;

  const searchAddon = getSearchAddon(activeTabId);

  const findNext = () => {
    if (searchAddon && query) searchAddon.findNext(query);
  };

  const findPrevious = () => {
    if (searchAddon && query) searchAddon.findPrevious(query);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        findPrevious();
      } else {
        findNext();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      searchAddon?.clearDecorations();
      closeSearch();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (searchAddon && val) {
      searchAddon.findNext(val);
    } else {
      searchAddon?.clearDecorations();
    }
  };

  return (
    <div className="search-bar">
      <input
        ref={inputRef}
        className="search-input"
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Search..."
      />
      <button className="search-btn" onClick={findPrevious} title="Previous (Shift+Enter)">&#9650;</button>
      <button className="search-btn" onClick={findNext} title="Next (Enter)">&#9660;</button>
      <button className="search-btn" onClick={() => { searchAddon?.clearDecorations(); closeSearch(); }} title="Close (Esc)">×</button>
    </div>
  );
}
