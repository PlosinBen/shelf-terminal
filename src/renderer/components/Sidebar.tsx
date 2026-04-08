import React from 'react';
import {
  useStore,
  setActiveProject,
  removeProject,
  setEditingProject,
} from '../store';
import { disposeTerminal } from './TerminalView';

export function Sidebar() {
  const { projects, activeProjectIndex } = useStore();

  const handleNewProject = () => {
    // Dispatch custom event for FolderPicker to open
    window.dispatchEvent(new CustomEvent('shelf:open-folder-picker'));
  };

  const handleRemoveProject = (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const proj = projects[index];
    // Kill all pty processes for this project
    proj.tabs.forEach((tab) => {
      window.shelfApi.pty.kill(tab.id);
      disposeTerminal(tab.id);
    });
    removeProject(index);
    // Persist
    const configs = projects.filter((_, i) => i !== index).map((p) => p.config);
    window.shelfApi.project.save(configs);
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
          return (
            <div
              key={proj.config.id}
              className={`sidebar-item ${i === activeProjectIndex ? 'active' : ''}`}
              onClick={() => setActiveProject(i)}
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
