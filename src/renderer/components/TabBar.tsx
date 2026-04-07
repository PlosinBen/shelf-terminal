import React, { useState, useRef, useEffect } from 'react';
import {
  useStore,
  addTab,
  removeTab,
  setActiveTab,
  renameTab,
  reorderTabs,
  clearUnread,
} from '../store';

export function TabBar() {
  const { projects, activeProjectIndex } = useStore();
  const project = projects[activeProjectIndex];

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingIndex !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingIndex]);

  if (!project) {
    return <div className="tab-bar" />;
  }

  const handleNewTab = () => {
    const tab = addTab(activeProjectIndex);
    if (tab) {
      window.shelfApi.pty.spawn(project.config.id, tab.id, project.config.cwd, project.config.connection);
    }
  };

  const handleCloseTab = (tabIndex: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const tab = project.tabs[tabIndex];
    if (tab) {
      window.shelfApi.pty.kill(tab.id);
    }
    removeTab(activeProjectIndex, tabIndex);
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
    </div>
  );
}
