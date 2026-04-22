import React, { useState, useEffect, useRef } from 'react';
import {
  useStore,
  setActiveProject,
  setEditingProject,
  toggleSettings,
  toggleSidebar,
  reorderProjects,
} from '../store';
import { emit, Events } from '../events';
import { CONFIRM_REMOVE_EVENT } from './RemoveConfirmDialog';

const version = __APP_VERSION__;

export function Sidebar() {
  const { projects, activeProjectIndex, updateStatus } = useStore();
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
        <button className="sidebar-btn" onClick={toggleSidebar} title="Collapse sidebar">&#9776;</button>
        <span>Shelf</span>
        <span className="sidebar-header-actions">
          <button className="sidebar-btn" onClick={toggleSettings} title="Settings">&#9881;</button>
          <button className="sidebar-btn" onClick={handleNewProject} title="New project">+</button>
        </span>
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
              onContextMenu={(e) => { setActiveProject(i); handleContextMenu(e, i); }}
              draggable
              onDragStart={(e) => handleDragStart(e, i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={(e) => handleDrop(e, i)}
              onDragEnd={handleDragEnd}
            >
              <span className={`status-dot ${hasAlive ? 'alive' : 'dead'}`} />
              <span className="project-name-group">
                <span className="project-name">{proj.config.name}</span>
                {proj.config.worktreeBranch && (
                  <span className="project-branch">{proj.config.worktreeBranch}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <span className="sidebar-version">v{version}</span>
        {updateStatus.state === 'available' && (
          <button
            className="sidebar-update-btn"
            title={`Download v${updateStatus.version}`}
            onClick={() => window.shelfApi.updater.download()}
          >
            &#x21E9;
          </button>
        )}
        {updateStatus.state === 'downloading' && (
          <div
            className="sidebar-update-progress"
            title={`Downloading v${updateStatus.version} — ${Math.round(updateStatus.percent)}%`}
          >
            <div
              className="sidebar-update-progress-bar"
              style={{ width: `${Math.max(0, Math.min(100, updateStatus.percent))}%` }}
            />
          </div>
        )}
        {updateStatus.state === 'downloaded' && (
          <button
            className="sidebar-update-btn ready"
            title={`Install v${updateStatus.version}`}
            onClick={() => window.shelfApi.updater.install()}
          >
            &#x21BB;
          </button>
        )}
      </div>

      {contextMenu && (() => {
        const proj = projects[contextMenu.index];
        const isConnected = proj && proj.tabs.length > 0;
        const isInvalid = proj?.folderInvalid;
        return (
          <div
            ref={menuRef}
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            {isConnected ? (
              <button
                className="context-menu-item"
                onClick={() => { emit(Events.DISCONNECT_PROJECT, contextMenu.index); setContextMenu(null); }}
              >
                Disconnect
              </button>
            ) : (
              <button
                className="context-menu-item"
                disabled={isInvalid}
                onClick={() => { emit(Events.CONNECT_PROJECT, contextMenu.index); setContextMenu(null); }}
              >
                Connect
              </button>
            )}
            {!proj?.config.parentProjectId && (
              <button
                className="context-menu-item"
                disabled={isInvalid}
                onClick={() => { emit(Events.CREATE_WORKTREE, contextMenu.index); setContextMenu(null); }}
              >
                New Worktree
              </button>
            )}
            <button
              className="context-menu-item"
              onClick={() => { setEditingProject(contextMenu.index); setContextMenu(null); }}
            >
              Edit
            </button>
            <div className="context-menu-separator" />
            <button
              className="context-menu-item context-menu-item-danger"
              onClick={() => { emit(CONFIRM_REMOVE_EVENT, contextMenu.index); setContextMenu(null); }}
            >
              Remove
            </button>
          </div>
        );
      })()}
    </aside>
  );
}
