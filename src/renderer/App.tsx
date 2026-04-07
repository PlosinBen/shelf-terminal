import React, { useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { TerminalView } from './components/TerminalView';
import { FolderPicker } from './components/FolderPicker';
import { useKeybindings } from './hooks/useKeybindings';
import { useStore, setProjects, addTab } from './store';
import './styles/global.css';

export function App() {
  const { projects, activeProjectIndex, sidebarVisible } = useStore();
  useKeybindings();

  useEffect(() => {
    // Load projects on startup and spawn one tab each
    window.shelfApi.project.load().then((configs) => {
      setProjects(configs);
      // Auto-open one tab per project (Task #12: App restart recovery)
      configs.forEach((_, i) => {
        const tab = addTab(i);
        if (tab) {
          window.shelfApi.pty.spawn(configs[i].id, tab.id, configs[i].cwd);
        }
      });
    });
  }, []);

  const activeProject = projects[activeProjectIndex] ?? null;

  return (
    <div className="app">
      {sidebarVisible && <Sidebar />}
      <main className="main-area">
        <TabBar />
        <div className="terminal-view">
          {activeProject && activeProject.tabs.map((tab, i) => (
            <TerminalView
              key={tab.id}
              tabId={tab.id}
              projectId={activeProject.config.id}
              cwd={activeProject.config.cwd}
              visible={i === activeProject.activeTabIndex}
            />
          ))}
        </div>
      </main>
      <FolderPicker />
    </div>
  );
}
