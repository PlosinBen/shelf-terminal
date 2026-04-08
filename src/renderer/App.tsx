import React, { useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { TerminalView } from './components/TerminalView';
import { FolderPicker } from './components/FolderPicker';
import { SettingsPanel } from './components/SettingsPanel';
import { SearchBar } from './components/SearchBar';
import { ProjectEditPanel } from './components/ProjectEditPanel';
import { useKeybindings } from './hooks/useKeybindings';
import { useStore, setProjects, setSettings, addProject, addTab, removeTab, removeProject } from './store';
import type { ProjectConfig } from '../shared/types';
import { disposeTerminal } from './components/TerminalView';
import { on, Events } from './events';
import { getTheme } from './themes';
import './styles/global.css';

export function App() {
  const { projects, activeProjectIndex, sidebarVisible, settings } = useStore();
  useKeybindings();

  useEffect(() => {
    window.shelfApi.settings.load().then(setSettings);
  }, []);

  // Centralized event handlers
  useEffect(() => {
    const offCloseTab = on(Events.CLOSE_TAB, (projectIndex: number, tabIndex: number) => {
      const proj = projects[projectIndex];
      const tab = proj?.tabs[tabIndex];
      if (tab) {
        window.shelfApi.pty.kill(tab.id);
        disposeTerminal(tab.id);
      }
      removeTab(projectIndex, tabIndex);
    });

    const offCloseProject = on(Events.CLOSE_PROJECT, (projectIndex: number) => {
      const proj = projects[projectIndex];
      if (proj) {
        proj.tabs.forEach((tab) => {
          window.shelfApi.pty.kill(tab.id);
          disposeTerminal(tab.id);
        });
      }
      removeProject(projectIndex);
      const configs = projects.filter((_, i) => i !== projectIndex).map((p) => p.config);
      window.shelfApi.project.save(configs);
    });

    const offNewTab = on(Events.NEW_TAB, (projectIndex: number) => {
      const proj = projects[projectIndex];
      if (!proj) return;
      const tab = addTab(projectIndex);
      if (tab) {
        window.shelfApi.pty.spawn(proj.config.id, tab.id, proj.config.cwd, proj.config.connection, proj.config.initScript);
      }
    });

    const offAddProject = on(Events.ADD_PROJECT, async (config: ProjectConfig) => {
      addProject(config);
      // Persist after addProject updates the store
      const configs = [...projects.map((p) => p.config), config];
      await window.shelfApi.project.save(configs);
    });

    return () => { offCloseTab(); offCloseProject(); offNewTab(); offAddProject(); };
  }, [projects]);

  useEffect(() => {
    // Load projects on startup and spawn one tab each
    window.shelfApi.project.load().then((configs) => {
      setProjects(configs);
      // Auto-open one tab per project (Task #12: App restart recovery)
      configs.forEach((_, i) => {
        const tab = addTab(i);
        if (tab) {
          window.shelfApi.pty.spawn(configs[i].id, tab.id, configs[i].cwd, configs[i].connection, configs[i].initScript);
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
          <SearchBar />
          {activeProject && activeProject.tabs.map((tab, i) => (
            <TerminalView
              key={tab.id}
              tabId={tab.id}
              projectId={activeProject.config.id}
              cwd={activeProject.config.cwd}
              connection={activeProject.config.connection}
              initScript={activeProject.config.initScript}
              visible={i === activeProject.activeTabIndex}
            />
          ))}
        </div>
      </main>
      <FolderPicker />
      <SettingsPanel />
      <ProjectEditPanel />
    </div>
  );
}
