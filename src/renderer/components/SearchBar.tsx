import React, { useState, useRef, useEffect } from 'react';
import { useStore, closeSearch } from '../store';
import { getSearchAddon } from './TerminalView';

export function SearchBar() {
  const { searchVisible, projects, activeProjectIndex } = useStore();
  const [query, setQuery] = useState('');
  // Match counter for DOM-based tabs (agent / web) via findInPage. null while no
  // active search; xterm terminal search doesn't populate it.
  const [matchInfo, setMatchInfo] = useState<{ active: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeProject = projects[activeProjectIndex];
  const activeTab = activeProject?.tabs[activeProject.activeTabIndex];
  const activeTabId = activeTab?.id;
  // Terminal tabs search through xterm's SearchAddon; agent / web tabs are plain
  // DOM with no addon, so they drive Chromium's native findInPage in main.
  const useFindInPage = !!activeTab && activeTab.type !== 'terminal';

  useEffect(() => {
    if (searchVisible && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [searchVisible]);

  // Subscribe to findInPage results (match counter) while the bar is open on a
  // DOM-based tab. Clear any lingering highlight when the bar closes.
  useEffect(() => {
    if (!searchVisible || !useFindInPage) {
      setMatchInfo(null);
      return;
    }
    const off = window.shelfApi.find.onResult((r) => {
      setMatchInfo({ active: r.activeMatchOrdinal, total: r.matches });
    });
    return () => {
      off();
      window.shelfApi.find.stop();
    };
  }, [searchVisible, useFindInPage, activeTabId]);

  if (!searchVisible || !activeTabId) return null;

  const searchAddon = useFindInPage ? null : getSearchAddon(activeTabId);

  const findNext = () => {
    if (!query) return;
    if (useFindInPage) window.shelfApi.find.query(query, { forward: true, findNext: true });
    else searchAddon?.findNext(query);
  };

  const findPrevious = () => {
    if (!query) return;
    if (useFindInPage) window.shelfApi.find.query(query, { forward: false, findNext: true });
    else searchAddon?.findPrevious(query);
  };

  const close = () => {
    if (useFindInPage) {
      window.shelfApi.find.stop();
      setMatchInfo(null);
    } else {
      searchAddon?.clearDecorations();
    }
    closeSearch();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) findPrevious();
      else findNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (useFindInPage) {
      if (val) {
        window.shelfApi.find.query(val, { forward: true, findNext: false });
      } else {
        window.shelfApi.find.stop();
        setMatchInfo(null);
      }
    } else if (searchAddon && val) {
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
      {useFindInPage && query && matchInfo && (
        <span className="search-count">{matchInfo.total > 0 ? `${matchInfo.active}/${matchInfo.total}` : '0/0'}</span>
      )}
      <button className="search-btn" onClick={findPrevious} title="Previous (Shift+Enter)">&#9650;</button>
      <button className="search-btn" onClick={findNext} title="Next (Enter)">&#9660;</button>
      <button className="search-btn" onClick={close} title="Close (Esc)">×</button>
    </div>
  );
}
