import React, { useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { TerminalView } from './components/TerminalView';
import { FolderPicker } from './components/FolderPicker';
import { SettingsPanel } from './components/SettingsPanel';
import { useKeybindings } from './hooks/useKeybindings';
import { useStore, setProjects, setSettings, addTab } from './store';
import { getTheme } from './themes';
import './styles/global.css';

export function App() {
  const { projects, activeProjectIndex, sidebarVisible, settings } = useStore();
  useKeybindings();

  useEffect(() => {
    window.shelfApi.settings.load().then(setSettings);
  }, []);

  useEffect(() => {
    // Load projects on startup and spawn one tab each
    window.shelfApi.project.load().then((configs) => {
      setProjects(configs);
      // Auto-open one tab per project (Task #12: App restart recovery)
      configs.forEach((_, i) => {
        const tab = addTab(i);
        if (tab) {
          window.shelfApi.pty.spawn(configs[i].id, tab.id, configs[i].cwd, configs[i].connection);
        }
      });
    });
  }, []);

  const theme = getTheme(settings.themeName);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--bg', theme.ui.bg);
    root.style.setProperty('--bg-secondary', theme.ui.bgSecondary);
    root.style.setProperty('--border', theme.ui.border);
    root.style.setProperty('--text', theme.ui.text);
    root.style.setProperty('--text-muted', theme.ui.textMuted);
    root.style.setProperty('--accent', theme.ui.accent);
    root.style.setProperty('--surface', theme.ui.surface);
  }, [theme]);

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
              connection={activeProject.config.connection}
              visible={i === activeProject.activeTabIndex}
            />
          ))}
        </div>
      </main>
      <FolderPicker />
      <SettingsPanel />
    </div>
  );
}
