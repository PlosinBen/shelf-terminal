import React, { useState, useEffect, useRef } from 'react';
import {
  useStore,
  setActiveProject,
  setEditingProject,
  reorderProjects,
} from '../store';
import { emit, Events } from '../events';

export function Sidebar() {
  const { projects, activeProjectIndex } = useStore();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ index: number; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close context menu on outside click
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

  const handleContextMenu = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    setContextMenu({ index, x: e.clientX, y: e.clientY });
  };

  const handleNewProject = () => {
    emit(Events.OPEN_FOLDER_PICKER);
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
      reorderProjects(dragIndex, toIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span>Shelf</span>
        <button className="sidebar-btn" onClick={handleNewProject} title="New project">
          +
        </button>
      </div>
      <div className="sidebar-list">
        {projects.map((proj, i) => {
          const hasAlive = proj.tabs.length > 0;
          const isDragging = dragIndex === i;
          const isDragOver = dragOverIndex === i && dragIndex !== i;

          return (
            <div
              key={proj.config.id}
              className={`sidebar-item ${i === activeProjectIndex ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
              onClick={() => setActiveProject(i)}
              onContextMenu={(e) => handleContextMenu(e, i)}
              draggable
              onDragStart={(e) => handleDragStart(e, i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={(e) => handleDrop(e, i)}
              onDragEnd={handleDragEnd}
            >
              <span className={`status-dot ${hasAlive ? 'alive' : 'dead'}`} />
              <span className="project-name">{proj.config.name}</span>
            </div>
          );
        })}
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            className="context-menu-item"
            onClick={() => { setEditingProject(contextMenu.index); setContextMenu(null); }}
          >
            Edit
          </button>
          <button
            className="context-menu-item context-menu-item-danger"
            onClick={() => { emit(Events.CLOSE_PROJECT, contextMenu.index); setContextMenu(null); }}
          >
            Close
          </button>
        </div>
      )}
    </aside>
  );
}
