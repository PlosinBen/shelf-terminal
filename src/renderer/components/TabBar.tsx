import React, { useState, useRef, useEffect } from 'react';
import {
  useStore,
  setActiveTab,
  renameTab,
  reorderTabs,
  clearUnread,
  toggleSidebar,
  toggleMuted,
  setTabColor,
  appendDefaultTab,
} from '../store';
import { emit, Events } from '../events';

const TAB_COLORS = [
  { name: 'Red', hex: '#f38ba8' },
  { name: 'Orange', hex: '#fab387' },
  { name: 'Yellow', hex: '#f9e2af' },
  { name: 'Green', hex: '#a6e3a1' },
  { name: 'Teal', hex: '#94e2d5' },
  { name: 'Blue', hex: '#89b4fa' },
  { name: 'Purple', hex: '#cba6f7' },
  { name: 'Pink', hex: '#f5c2e7' },
];

export { TAB_COLORS };

export function TabBar() {
  const { projects, activeProjectIndex, sidebarVisible } = useStore();
  const project = projects[activeProjectIndex];

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ index: number; x: number; y: number } | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editingIndex !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingIndex]);

  useEffect(() => {
    if (!contextMenu && !addMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenu && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
      if (addMenu && addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu, addMenu]);

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

  const tabStyle = (color: string | undefined, isActive: boolean): React.CSSProperties => {
    if (!color) return {};
    return { backgroundColor: isActive ? color + 'a0' : color + '70' };
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
        const isActive = i === project.activeTabIndex;

        return (
          <div
            key={tab.id}
            className={`tab ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
            style={tabStyle(tab.color, isActive)}
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
                {tab.type === 'agent' && <span className="tab-agent-icon" title="Agent">&#9672;</span>}
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
        onContextMenu={(e) => {
          e.preventDefault();
          if (project.tabs.length < project.config.maxTabs) {
            setAddMenu({ x: e.clientX, y: e.clientY });
          }
        }}
        title="New terminal (right-click for more)"
        disabled={project.tabs.length >= project.config.maxTabs}
      >
        +
      </button>

      {addMenu && (
        <div
          ref={addMenuRef}
          className="context-menu"
          style={{ top: addMenu.y, left: addMenu.x }}
        >
          <button
            className="context-menu-item"
            onClick={() => { handleNewTab(); setAddMenu(null); }}
          >
            Terminal
          </button>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item"
            onClick={() => { emit(Events.NEW_AGENT_TAB, activeProjectIndex); setAddMenu(null); }}
          >
            Agent
          </button>
        </div>
      )}

      {contextMenu && (() => {
        const tab = project.tabs[contextMenu.index];
        if (!tab) return null;
        return (
          <div
            ref={menuRef}
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <div className="context-menu-section">
              <span className="context-menu-label">Color</span>
              <div className="context-menu-colors">
                <button
                  className={`color-swatch color-swatch-none ${!tab.color ? 'active' : ''}`}
                  onClick={() => { setTabColor(activeProjectIndex, contextMenu.index, undefined); setContextMenu(null); }}
                  title="No color"
                />
                {TAB_COLORS.map((c) => (
                  <button
                    key={c.hex}
                    className={`color-swatch ${tab.color === c.hex ? 'active' : ''}`}
                    style={{ backgroundColor: c.hex }}
                    onClick={() => { setTabColor(activeProjectIndex, contextMenu.index, c.hex); setContextMenu(null); }}
                    title={c.name}
                  />
                ))}
              </div>
            </div>
            <div className="context-menu-divider" />
            <button
              className="context-menu-item"
              onClick={() => { handleDoubleClick(contextMenu.index); setContextMenu(null); }}
            >
              Rename
            </button>
            <button
              className="context-menu-item"
              onClick={() => { appendDefaultTab(activeProjectIndex, tab.label, tab.color); setContextMenu(null); }}
            >
              Save to Default
            </button>
            <div className="context-menu-divider" />
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
