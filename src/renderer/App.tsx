import React, { useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { TerminalView } from './components/TerminalView';
import { AgentView } from './components/AgentView';
import { FolderPicker } from './components/FolderPicker';
import { SettingsPanel } from './components/SettingsPanel';
import { SearchBar } from './components/SearchBar';
import { ProjectEditPanel } from './components/ProjectEditPanel';
import { CommandPicker } from './components/CommandPicker';
import { WorktreeDialog } from './components/WorktreeDialog';
import { RemoveConfirmDialog } from './components/RemoveConfirmDialog';
import { BottomBar, SWITCH_BRANCH_EVENT } from './components/BottomBar';
import { DevToolsPanel } from './components/DevToolsPanel';
import { PmView } from './components/PmView';
import { NotesView } from './components/NotesView';
import { useKeybindings, isMac } from './hooks/useKeybindings';
import { tooltipWithShortcut } from './utils/format-keybinding';
import { useStore, setProjects, setSettings, setUpdateStatus, addProject, addTab, setActiveTab, removeTab, removeProject, setSplitTab, toggleSidebar, clearUnread, setInvalidProjects, setPmVisible, toggleDevTools, toggleNotes } from './store';
import type { ProjectConfig } from '@shared/types';
import { disposeTerminal } from './components/TerminalView';
import { on, emit, Events } from './events';
import { bindAgentIPCGroup } from './events';
import { bindAgentStoreSubscriptions } from './agentTabSubscriptions';
import { setInMemoryMax, setSaveThrottleMs } from './agentTabStore';
import { getTheme } from './themes';
import { clearAgentSession } from './storage/agent-history';
import './styles/global.css';

export function App() {
  const { projects, activeProjectIndex, sidebarVisible, settingsVisible, commandPickerVisible, devToolsVisible, notesVisible, editingProjectIndex, settings, pmVisible, awayMode } = useStore();
  useKeybindings();

  useEffect(() => {
    window.shelfApi.settings.load().then(setSettings);
  }, []);

  useEffect(() => {
    return window.shelfApi.updater.onStatus(setUpdateStatus);
  }, []);

  // Wire the typed agent event layer once at app lifetime. IPC ↔ bus
  // adapter and bus → store subscriptions are both global; per-tab
  // routing happens inside agentTabStore via tabId in payloads. Living
  // at App.tsx (not AgentView mount) means IPC streams survive
  // AgentView unmount mid-turn — see DECISIONS #59.
  useEffect(() => {
    const offIPC = bindAgentIPCGroup();
    const offStore = bindAgentStoreSubscriptions();
    return () => { offIPC(); offStore(); };
  }, []);

  // Push agent in-memory cap + save throttle settings into the
  // agentTabStore module. Store keeps its own module-scoped copies
  // (not React state) so non-React subscription handlers can read
  // them without going through hooks. Re-fires on settings change.
  useEffect(() => {
    setInMemoryMax(settings.agentInMemoryMaxMessages);
    setSaveThrottleMs(settings.agentHistorySaveThrottleMs);
  }, [
    settings.agentInMemoryMaxMessages,
    settings.agentHistorySaveThrottleMs,
  ]);

  // Centralized event handlers
  useEffect(() => {
    const offCloseTab = on(Events.CLOSE_TAB, (projectIndex: number, tabIndex: number) => {
      const proj = projects[projectIndex];
      const tab = proj?.tabs[tabIndex];
      if (tab) {
        if (tab.type === 'agent') {
          window.shelfApi.agent.destroy(tab.id);
        } else {
          window.shelfApi.pty.kill(tab.id);
          disposeTerminal(tab.id);
        }
      }
      removeTab(projectIndex, tabIndex);
    });

    const offRemoveProject = on(Events.REMOVE_PROJECT, (projectIndex: number) => {
      const proj = projects[projectIndex];
      if (proj) {
        // Clean up agent session data (IndexedDB)
        const sessionIds = proj.config.agentSessionIds;
        if (sessionIds) {
          Object.values(sessionIds).forEach((id) => { if (id) clearAgentSession(id); });
        }
        proj.tabs.forEach((tab) => {
          if (tab.type === 'agent') {
            window.shelfApi.agent.destroy(tab.id);
          } else {
            window.shelfApi.pty.kill(tab.id);
            disposeTerminal(tab.id);
          }
        });
      }
      removeProject(projectIndex);
      const configs = projects.filter((_, i) => i !== projectIndex).map((p) => p.config);
      window.shelfApi.project.save(configs);
    });

    const offNewTab = on(Events.NEW_TAB, (projectIndex: number) => {
      const proj = projects[projectIndex];
      if (!proj) return;
      addTab(projectIndex);
    });

    const offNewAgentTab = on(Events.NEW_AGENT_TAB, (projectIndex: number, provider?: import('@shared/types').AgentProvider) => {
      const proj = projects[projectIndex];
      if (!proj) return;
      const resolvedProvider = provider ?? proj.config.defaultAgentProvider ?? 'claude';
      addTab(projectIndex, undefined, undefined, undefined, 'agent', resolvedProvider);
    });

    const offConnectProject = on(Events.CONNECT_PROJECT, async (projectIndex: number) => {
      const proj = projects[projectIndex];
      if (!proj || proj.tabs.length > 0) return;

      // Establish SSH ControlMaster before spawning tabs
      const conn = proj.config.connection;
      if (conn.type === 'ssh' && conn.password) {
        try {
          await window.shelfApi.connector.connect(conn, conn.password);
        } catch (err: any) {
          const msg = err?.message ?? '';
          if (msg.includes('HOST_KEY_CHANGED')) {
            const fingerprint = msg.match(/fingerprint:(\S+)/)?.[1] ?? 'unknown';
            const confirmed = window.confirm(
              `Host key for ${conn.host}:${conn.port} has changed.\n\n` +
              `New fingerprint: ${fingerprint}\n\n` +
              `This could indicate a server reinstall or a man-in-the-middle attack.\n` +
              `Trust the new key and reconnect?`
            );
            if (confirmed) {
              await window.shelfApi.ssh.removeHostKey(conn.host, conn.port);
              try {
                await window.shelfApi.connector.connect(conn, conn.password);
              } catch {
                return;
              }
            } else {
              return;
            }
          } else {
            return;
          }
        }
      }

      if (proj.config.openAgentOnConnect) {
        const provider = proj.config.defaultAgentProvider ?? 'claude';
        addTab(projectIndex, undefined, undefined, undefined, 'agent', provider);
      }

      const templates = proj.config.defaultTabs;
      if (templates && templates.length > 0) {
        templates.forEach((t) => addTab(projectIndex, t.name, t.cmd, t.color));
      } else {
        addTab(projectIndex);
      }
      setActiveTab(projectIndex, 0);
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
          setSplitTab(projectIndex, tab.id);
        }
      }
    });

    const offSwitchBranch = on(SWITCH_BRANCH_EVENT, async (projectIndex: number, branch: string, callback: (success: boolean, branch?: string) => void) => {
      const proj = projects[projectIndex];
      if (!proj) { callback(false); return; }

      const result = await window.shelfApi.git.checkout(proj.config.connection, proj.config.cwd, branch);
      if (result.ok) {
        callback(true, branch);
      } else {
        void window.shelfApi.dialog.warn('Branch switch failed', result.error ?? 'Unknown error');
        callback(false);
      }
    });

    return () => { offCloseTab(); offRemoveProject(); offNewTab(); offNewAgentTab(); offConnectProject(); offDisconnectProject(); offAddProject(); offToggleSplit(); offSwitchBranch(); };
  }, [projects]);

  useEffect(() => {
    window.shelfApi.project.load().then((configs) => {
      setProjects(configs);
      window.shelfApi.project.validateDirs(configs).then(setInvalidProjects);
    });
  }, []);

  // Re-focus active terminal when window regains focus or panels close
  const focusTerminal = () => {
    // Clear unread badge on active tab when window regains focus
    const proj = projects[activeProjectIndex];
    if (proj) clearUnread(activeProjectIndex, proj.activeTabIndex);

    requestAnimationFrame(() => {
      const textarea = document.querySelector('.terminal-container:not([style*="display: none"]) .xterm-helper-textarea') as HTMLElement;
      textarea?.focus();
    });
  };

  useEffect(() => {
    window.addEventListener('focus', focusTerminal);
    return () => window.removeEventListener('focus', focusTerminal);
  }, []);

  useEffect(() => {
    if (!settingsVisible && !commandPickerVisible && !devToolsVisible && editingProjectIndex === null) {
      focusTerminal();
    }
  }, [settingsVisible, commandPickerVisible, devToolsVisible, editingProjectIndex]);

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
        <div className="terminal-section">
        <TabBar />
        <div className="terminal-view">
          <SearchBar />
          {activeProject && activeProject.folderInvalid && (
            <div className="invalid-folder-overlay">
              <span>Invalid folder</span>
              <span className="invalid-folder-path">{activeProject.config.cwd}</span>
            </div>
          )}
          {activeProject && !activeProject.folderInvalid && activeProject.tabs.length === 0 && (
            <div
              className="connect-prompt"
              onClick={() => emit(Events.CONNECT_PROJECT, activeProjectIndex)}
              onKeyDown={(e) => { if (e.key === 'Enter') emit(Events.CONNECT_PROJECT, activeProjectIndex); }}
              tabIndex={0}
              ref={(el) => el?.focus()}
            >
              Click or press Enter to connect to <strong>{activeProject.config.name}</strong>
            </div>
          )}
          <div className={activeProject?.splitTabId ? 'split-view' : 'terminal-fill'}>
            {projects.map((proj, pi) => {
                const isActiveProject = pi === activeProjectIndex;
                const isSplit = isActiveProject && proj.splitTabId !== null;

                return proj.tabs.map((tab, ti) => {
                  const isActiveTab = ti === proj.activeTabIndex;
                  const isSplitTab = tab.id === proj.splitTabId;
                  const visible = isActiveProject && (isSplit ? (isActiveTab || isSplitTab) : isActiveTab);

                  return (
                    <div
                      key={tab.id}
                      className={isSplit && visible ? 'split-pane' : undefined}
                      style={!visible ? { display: 'none' } : undefined}
                    >
                      {tab.type === 'agent' && tab.provider ? (
                        <AgentView
                          tabId={tab.id}
                          cwd={proj.config.cwd}
                          connection={proj.config.connection}
                          provider={tab.provider}
                          projectId={proj.config.id}
                          visible={visible}
                        />
                      ) : (
                        <TerminalView
                          tabId={tab.id}
                          projectId={proj.config.id}
                          cwd={proj.config.cwd}
                          connection={proj.config.connection}
                          initScript={proj.config.initScript}
                          tabCmd={tab.cmd}
                          visible={visible}
                        />
                      )}
                    </div>
                  );
                });
              })}
          </div>
        </div>
        <BottomBar />
        {awayMode && (
          <div className="away-mode-overlay">
            <span>Away Mode — PM is in control</span>
          </div>
        )}
        </div>
        {pmVisible && <PmView />}
        {notesVisible && <NotesView />}
        {devToolsVisible && <DevToolsPanel />}
        {(!pmVisible || !notesVisible || !devToolsVisible) && (
          <div className="right-tabs-collapsed">
            {!pmVisible && (
              <button className="right-tab-btn" onClick={() => setPmVisible(true)} title="PM Agent">
                <span className={`pm-tab-dot ${awayMode ? 'pm-dot-away' : 'pm-dot'}`} />
                <span>PM</span>
              </button>
            )}
            {!notesVisible && (
              <button className="right-tab-btn" onClick={toggleNotes} title={tooltipWithShortcut('Notes', settings.keybindings.toggleNotes, isMac)}>
                <span>Notes</span>
              </button>
            )}
            {!devToolsVisible && (
              <button className="right-tab-btn" onClick={toggleDevTools} title={tooltipWithShortcut('Dev Tools', settings.keybindings.toggleDevTools, isMac)}>
                <span>Dev Tools</span>
              </button>
            )}
          </div>
        )}
      </main>
      <FolderPicker />
      <SettingsPanel />
      <ProjectEditPanel />
      <CommandPicker />
      <WorktreeDialog />
      <RemoveConfirmDialog />
    </div>
  );
}
