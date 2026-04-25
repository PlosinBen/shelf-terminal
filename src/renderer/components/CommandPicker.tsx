import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useStore, closeCommandPicker } from '../store';
import type { QuickCommand } from '@shared/types';

export function CommandPicker() {
  const { commandPickerVisible, projects, activeProjectIndex } = useStore();
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const project = projects[activeProjectIndex];
  const commands: QuickCommand[] = project?.config.quickCommands ?? [];
  const filtered = commands.filter(
    (c) =>
      c.label.toLowerCase().includes(filter.toLowerCase()) ||
      c.command.toLowerCase().includes(filter.toLowerCase()),
  );

  useEffect(() => {
    if (commandPickerVisible) {
      setFilter('');
      setSelectedIndex(0);
      // useEffect runs after DOM commit, so the input is already mounted.
      // No rAF needed — and rAF created a race where a fast Escape press
      // (e2e test or impatient user) reached the body before focus was set,
      // leaving the picker unable to receive its own onKeyDown.
      inputRef.current?.focus();
    }
  }, [commandPickerVisible]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const executeCommand = useCallback(
    (cmd: QuickCommand) => {
      if (!project) return;
      const tabs = project.tabs;

      let tabId: string | undefined;
      if (cmd.target === 'current') {
        tabId = tabs[project.activeTabIndex]?.id;
      } else {
        // Match by tab label
        const matched = tabs.find((t) => t.label === cmd.target);
        tabId = matched?.id;
      }

      if (tabId) {
        window.shelfApi.pty.input(tabId, cmd.command + '\n');
      }
      closeCommandPicker();
    },
    [project],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[selectedIndex]) {
          executeCommand(filtered[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        closeCommandPicker();
        break;
    }
  };

  if (!commandPickerVisible || !project) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) closeCommandPicker();
  };

  return (
    <div className="command-picker-overlay" onClick={handleOverlayClick}>
      <div className="command-picker" onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          className="command-picker-input"
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Type to filter commands..."
        />
        <div className="command-picker-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="command-picker-empty">
              {commands.length === 0
                ? 'No quick commands configured. Add them in Project Edit.'
                : 'No matching commands'}
            </div>
          )}
          {filtered.map((cmd, i) => (
            <div
              key={`${cmd.label}-${cmd.command}-${i}`}
              className={`command-picker-item ${i === selectedIndex ? 'selected' : ''}`}
              onClick={() => executeCommand(cmd)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="command-picker-label">{cmd.label}</span>
              <span className="command-picker-cmd">{cmd.command}</span>
              <span className="command-picker-target">
                {cmd.target === 'current' ? 'current tab' : cmd.target}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
