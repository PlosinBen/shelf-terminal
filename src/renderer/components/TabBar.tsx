import React from 'react';
import {
  useStore,
  addTab,
  removeTab,
  setActiveTab,
} from '../store';

export function TabBar() {
  const { projects, activeProjectIndex } = useStore();
  const project = projects[activeProjectIndex];

  if (!project) {
    return <div className="tab-bar" />;
  }

  const handleNewTab = () => {
    const tab = addTab(activeProjectIndex);
    if (tab) {
      window.shelfApi.pty.spawn(project.config.id, tab.id, project.config.cwd);
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

  return (
    <div className="tab-bar">
      {project.tabs.map((tab, i) => (
        <div
          key={tab.id}
          className={`tab ${i === project.activeTabIndex ? 'active' : ''}`}
          onClick={() => setActiveTab(activeProjectIndex, i)}
        >
          <span className="tab-label">{tab.label}</span>
          <button
            className="tab-close"
            onClick={(e) => handleCloseTab(i, e)}
          >
            ×
          </button>
        </div>
      ))}
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
