import React, { useState } from 'react';
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

  const handleNewProject = () => {
    emit(Events.OPEN_FOLDER_PICKER);
  };

  const handleRemoveProject = (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    emit(Events.CLOSE_PROJECT, index);
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
              draggable
              onDragStart={(e) => handleDragStart(e, i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={(e) => handleDrop(e, i)}
              onDragEnd={handleDragEnd}
            >
              <span className={`status-dot ${hasAlive ? 'alive' : 'dead'}`} />
              <span className="project-name">{proj.config.name}</span>
              <button
                className="sidebar-edit-btn"
                onClick={(e) => { e.stopPropagation(); setEditingProject(i); }}
                title="Edit project"
              >
                ⚙
              </button>
              <button
                className="sidebar-close-btn"
                onClick={(e) => handleRemoveProject(i, e)}
                title="Close project"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
