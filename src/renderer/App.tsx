import React, { useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { TerminalView } from './components/TerminalView';
import { FolderPicker } from './components/FolderPicker';
import { SettingsPanel } from './components/SettingsPanel';
import { SearchBar } from './components/SearchBar';
import { ProjectEditPanel } from './components/ProjectEditPanel';
import { useKeybindings } from './hooks/useKeybindings';
import { useStore, setProjects, setSettings, addProject, addTab, removeTab, removeProject, setSplitTab } from './store';
import type { ProjectConfig } from '../shared/types';
import { disposeTerminal } from './components/TerminalView';
import { on, emit, Events } from './events';
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

    const offConnectProject = on(Events.CONNECT_PROJECT, (projectIndex: number) => {
      const proj = projects[projectIndex];
      if (!proj || proj.tabs.length > 0) return;
      const tab = addTab(projectIndex);
      if (tab) {
        window.shelfApi.pty.spawn(proj.config.id, tab.id, proj.config.cwd, proj.config.connection, proj.config.initScript);
      }
    });

    const offDisconnectProject = on(Events.DISCONNECT_PROJECT, (projectIndex: number) => {
      const proj = projects[projectIndex];
      if (!proj || proj.tabs.length === 0) return;
      proj.tabs.forEach((tab) => {
        window.shelfApi.pty.kill(tab.id);
        disposeTerminal(tab.id);
      });
      // Remove all tabs but keep the project
      for (let t = proj.tabs.length - 1; t >= 0; t--) {
        removeTab(projectIndex, t);
      }
      setSplitTab(projectIndex, null);
    });

    const offAddProject = on(Events.ADD_PROJECT, async (config: ProjectConfig) => {
      addProject(config);
      const configs = [...projects.map((p) => p.config), config];
      await window.shelfApi.project.save(configs);
    });

    const offToggleSplit = on(Events.TOGGLE_SPLIT, (projectIndex: number) => {
      const proj = projects[projectIndex];
      if (!proj) return;

      if (proj.splitTabId) {
        // Close split — kill the split tab
        const splitTab = proj.tabs.find((t) => t.id === proj.splitTabId);
        if (splitTab) {
          window.shelfApi.pty.kill(splitTab.id);
          disposeTerminal(splitTab.id);
          const tabIndex = proj.tabs.findIndex((t) => t.id === splitTab.id);
          if (tabIndex !== -1) removeTab(projectIndex, tabIndex);
        }
        setSplitTab(projectIndex, null);
      } else {
        // Open split — spawn new tab and assign as split
        const tab = addTab(projectIndex);
        if (tab) {
          window.shelfApi.pty.spawn(proj.config.id, tab.id, proj.config.cwd, proj.config.connection, proj.config.initScript);
          setSplitTab(projectIndex, tab.id);
        }
      }
    });

    return () => { offCloseTab(); offCloseProject(); offNewTab(); offConnectProject(); offDisconnectProject(); offAddProject(); offToggleSplit(); };
  }, [projects]);

  useEffect(() => {
    // Load projects on startup (no auto-connect)
    window.shelfApi.project.load().then(setProjects);
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
          {activeProject && activeProject.tabs.length === 0 ? (
            <div
              className="connect-prompt"
              onClick={() => emit(Events.CONNECT_PROJECT, activeProjectIndex)}
              onKeyDown={(e) => { if (e.key === 'Enter') emit(Events.CONNECT_PROJECT, activeProjectIndex); }}
              tabIndex={0}
              ref={(el) => el?.focus()}
            >
              Click or press Enter to connect to <strong>{activeProject.config.name}</strong>
            </div>
          ) : activeProject && activeProject.tabs.length > 0 && activeProject.splitTabId ? (
            <div className="split-view">
              {activeProject.tabs.map((tab, i) => {
                const isActiveTab = i === activeProject.activeTabIndex;
                const isSplitTab = tab.id === activeProject.splitTabId;
                const visible = isActiveTab || isSplitTab;

                return (
                  <div
                    key={tab.id}
                    className={visible ? 'split-pane' : undefined}
                    style={!visible ? { display: 'none' } : undefined}
                  >
                    <TerminalView
                      tabId={tab.id}
                      projectId={activeProject.config.id}
                      cwd={activeProject.config.cwd}
                      connection={activeProject.config.connection}
                      initScript={activeProject.config.initScript}
                      visible={visible}
                    />
                  </div>
                );
              })}
            </div>
          ) : activeProject && activeProject.tabs.map((tab, i) => (
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
