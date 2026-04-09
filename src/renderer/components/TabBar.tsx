import React, { useState, useRef, useEffect } from 'react';
import {
  useStore,
  setActiveTab,
  renameTab,
  reorderTabs,
  clearUnread,
  toggleSidebar,
  toggleMuted,
} from '../store';
import { emit, Events } from '../events';

export function TabBar() {
  const { projects, activeProjectIndex, sidebarVisible } = useStore();
  const project = projects[activeProjectIndex];

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ index: number; x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editingIndex !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingIndex]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  if (!project) {
    return (
      <div className="tab-bar">
        {!sidebarVisible && (
          <button className="tab-sidebar-btn" onClick={toggleSidebar} title="Expand sidebar">&#9776;</button>
        )}
      </div>
    );
  }

  const handleNewTab = () => {
    emit(Events.NEW_TAB, activeProjectIndex);
  };

  const handleCloseTab = (tabIndex: number, e: React.MouseEvent) => {
    e.stopPropagation();
    emit(Events.CLOSE_TAB, activeProjectIndex, tabIndex);
  };

  const handleDoubleClick = (tabIndex: number) => {
    setEditingIndex(tabIndex);
    setEditValue(project.tabs[tabIndex].label);
  };

  const commitRename = () => {
    if (editingIndex !== null && editValue.trim()) {
      renameTab(activeProjectIndex, editingIndex, editValue.trim());
    }
    setEditingIndex(null);
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== toIndex) {
      reorderTabs(activeProjectIndex, dragIndex, toIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="tab-bar">
      {!sidebarVisible && (
        <button className="tab-sidebar-btn" onClick={toggleSidebar} title="Expand sidebar">&#9776;</button>
      )}
      {project.tabs.map((tab, i) => {
        const isEditing = editingIndex === i;
        const isDragging = dragIndex === i;
        const isDragOver = dragOverIndex === i && dragIndex !== i;

        return (
          <div
            key={tab.id}
            className={`tab ${i === project.activeTabIndex ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
            onClick={() => { clearUnread(activeProjectIndex, i); setActiveTab(activeProjectIndex, i); }}
            onDoubleClick={() => handleDoubleClick(i)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu({ index: i, x: e.clientX, y: e.clientY }); }}
            draggable={!isEditing}
            onDragStart={(e) => handleDragStart(e, i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDrop={(e) => handleDrop(e, i)}
            onDragEnd={handleDragEnd}
          >
            {isEditing ? (
              <input
                ref={inputRef}
                className="tab-rename-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditingIndex(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <span className="tab-label">{tab.label}</span>
                {tab.muted && <span className="tab-muted" title="Notifications muted">&#x1F515;</span>}
                {tab.hasUnread && <span className="tab-badge" />}
              </>
            )}
            <button
              className="tab-close"
              onClick={(e) => handleCloseTab(i, e)}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        className="tab-add"
        onClick={handleNewTab}
        title="New terminal"
        disabled={project.tabs.length >= project.config.maxTabs}
      >
        +
      </button>

      {contextMenu && (() => {
        const tab = project.tabs[contextMenu.index];
        if (!tab) return null;
        return (
          <div
            ref={menuRef}
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <button
              className="context-menu-item"
              onClick={() => { toggleMuted(activeProjectIndex, contextMenu.index); setContextMenu(null); }}
            >
              {tab.muted ? 'Unmute' : 'Mute'}
            </button>
            <button
              className="context-menu-item context-menu-item-danger"
              onClick={() => { emit(Events.CLOSE_TAB, activeProjectIndex, contextMenu.index); setContextMenu(null); }}
            >
              Close
            </button>
          </div>
        );
      })()}
    </div>
  );
}
