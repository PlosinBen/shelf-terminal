import React, { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { TerminalView } from './components/TerminalView';
import { AgentView } from './components/AgentView';
import { WebTabView } from './components/WebTabView';
import { WebPermissionPrompt } from './components/WebPermissionPrompt';
import { BrowserOpenPrompt } from './components/BrowserOpenPrompt';
import { FolderPicker } from './components/FolderPicker';
import { SettingsPanel } from './components/SettingsPanel';
import { SearchBar } from './components/SearchBar';
import { ProjectEditPanel } from './components/ProjectEditPanel';
import { CommandPicker } from './components/CommandPicker';
import { WorktreeDialog } from './components/WorktreeDialog';
import { WorktreeCloseGate } from './components/WorktreeCloseGate';
import { ProjectNoticeBanner } from './components/ProjectNoticeBanner';
import { RemoveConfirmDialog } from './components/RemoveConfirmDialog';
import { BottomBar, SWITCH_BRANCH_EVENT } from './components/BottomBar';
import { DevToolsPanel } from './components/DevToolsPanel';
import { PmView } from './components/PmView';
import { NotesView } from './components/NotesView';
import { SkillsView } from './components/SkillsView';
import { McpView } from './components/McpView';
import { QuickNoteOverlay } from './components/QuickNoteOverlay';
import { useKeybindings } from './hooks/useKeybindings';
import { useStore, setProjects, setSettings, setUpdateStatus, addProject, addTab, setActiveTab, removeTab, removeProject, setSplitTab, clearUnread, setInvalidProjects, setPmActive, setConnectionHealth, setActiveProject, setActiveProjectById, getProjectById, getProjectIndexById, getProjectConfigs, listStableProjectViews, showProjectNotice, resolveAgentProviderForOpen, resolveAgentProviderForConnect } from './store';
import type { ConnectionHealth } from '@shared/types';
import type { ProjectConfig } from '@shared/types';
import { disposeTerminal } from './components/TerminalView';
import { teardownTab } from './tab-teardown';
import { on, emit, Events } from './events';
import { bindAgentIPCGroup } from './events';
import { bindAgentStoreSubscriptions } from './agentTabSubscriptions';
import { setInMemoryMax, setSaveThrottleMs } from './agentTabStore';
import { getTheme, buildThemeVars } from './themes';
import { clearAgentSession } from './storage/agent-history';
import { bindProcessMemorySummary } from './process-memory-sync';
import './styles/global.css';

export function App() {
  const { projects, activeProjectIndex, activeProjectId, sidebarVisible, settingsVisible, commandPickerVisible, devToolsVisible, notesVisible, skillsVisible, mcpVisible, editingProjectIndex, settings, pmVisible, awayMode } = useStore();
  useKeybindings();

  // Auto-connect a just-added project (e.g. a fresh worktree) once it lands in the
  // store. Driven off `projects` (fresh) so the CONNECT_PROJECT handler — which
  // indexes the same fresh snapshot — resolves the new project; emitting inside a
  // bus handler right after ADD_PROJECT would hit the pre-add closure instead.
  const [pendingConnectId, setPendingConnectId] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingConnectId) return;
    const idx = projects.findIndex((p) => p.config.id === pendingConnectId);
    if (idx < 0) return; // not in the store yet — this effect re-runs when it lands
    setPendingConnectId(null);
    if (projects[idx].tabs.length > 0) return; // already connected
    // Defer past this effect-flush so the CONNECT_PROJECT handler (re-subscribed in
    // the SAME flush, whichever order the effects run) is live before we emit —
    // otherwise the emit can land between the bus effect's cleanup and re-subscribe.
    queueMicrotask(() => emit(Events.CONNECT_PROJECT, pendingConnectId));
  }, [projects, pendingConnectId]);

  useEffect(() => {
    window.shelfApi.settings.load().then(setSettings);
  }, []);

  useEffect(() => {
    return window.shelfApi.updater.onStatus(setUpdateStatus);
  }, []);

  // PM Active (telegram listener) status — synced app-wide so the tab-bar badge
  // reflects it whether or not the PM panel is open.
  useEffect(() => {
    window.shelfApi.pm.getActive().then(setPmActive);
    const offActive = window.shelfApi.pm.onActive(setPmActive);
    const offErr = window.shelfApi.pm.onActiveError((reason) => {
      // 'taken-over' (409) is expected when grabbing control on another machine
      // — the badge just disappears, no dialog. Only surface config errors.
      if (reason === 'taken-over') return;
      const msg = reason === 'bad-token'
        ? 'PM Active stopped: invalid Telegram bot token.'
        : reason === 'bad-chat-id'
        ? 'PM Active stopped: invalid Telegram chat id.'
        : 'PM Active stopped.';
      window.shelfApi.dialog.confirm('PM Active', msg, 'OK').catch(() => {});
    });
    return () => { offActive(); offErr(); };
  }, []);

  // Wire the typed agent event layer once at app lifetime. IPC ↔ bus
  // adapter and bus → store subscriptions are both global; per-tab
  // routing happens inside agentTabStore via tabId in payloads. Living
  // at App.tsx (not AgentView mount) means IPC streams survive
  // AgentView unmount mid-turn — see agent-ui#4.
  useEffect(() => {
    const offIPC = bindAgentIPCGroup();
    const offStore = bindAgentStoreSubscriptions();
    return () => { offIPC(); offStore(); };
  }, []);

  useEffect(() => bindProcessMemorySummary(), []);

  // Connection health (heartbeat) → main store, keyed by tabId. Bound directly
  // (not via the agent typed-event river) because it's connection
  // infrastructure, not agent-conversation domain state — the Sidebar reads it
  // off `store` to color the project status dot. See §5.9.
  useEffect(() => {
    return window.shelfApi.agent.onConnectionHealth((tabId: string, health: ConnectionHealth) => {
      setConnectionHealth(tabId, health);
    });
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
    const offCloseTab = on(Events.CLOSE_TAB, (projectId: string, tabIndex: number) => {
      const projectIndex = getProjectIndexById(projectId);
      const proj = getProjectById(projectId);
      const tab = proj?.tabs[tabIndex];
      if (tab) teardownTab(tab);
      removeTab(projectIndex, tabIndex);
    });

    const offRemoveProject = on(Events.REMOVE_PROJECT, (projectId: string) => {
      const projectIndex = getProjectIndexById(projectId);
      const proj = getProjectById(projectId);
      if (projectIndex === -1 || !proj) return;
      if (proj) {
        // Clean up agent session data (IndexedDB)
        const sessionIds = proj.config.agentSessionIds;
        if (sessionIds) {
          Object.values(sessionIds).forEach((id) => { if (id) clearAgentSession(id); });
        }
        proj.tabs.forEach(teardownTab);
      }
      removeProject(projectIndex);
      const configs = getProjectConfigs();
      window.shelfApi.project.save(configs);
    });

    const offWorktreeFinishCompleted = on(Events.WORKTREE_FINISH_COMPLETED, (payload: {
      subProjectId: string;
      parentProjectId: string;
      featureBranch: string;
      targetBranch: string;
    }) => {
      const configsAfter = projects
        .filter((p) => p.config.id !== payload.subProjectId)
        .map((p) => p.config);
      const parentIndexAfter = configsAfter.findIndex((p) => p.id === payload.parentProjectId);
      if (!getProjectById(payload.subProjectId) || parentIndexAfter === -1) {
        console.warn(`[worktree] finish-completed for unknown project pair ${payload.subProjectId} → ${payload.parentProjectId}`);
        return;
      }

      emit(Events.REMOVE_PROJECT, payload.subProjectId);
      setActiveProjectById(payload.parentProjectId);
      showProjectNotice({
        projectId: payload.parentProjectId,
        message: `Merged ${payload.featureBranch} → ${payload.targetBranch} and closed the worktree`,
      });
    });

    const offNewTab = on(Events.NEW_TAB, (projectId: string) => {
      const projectIndex = getProjectIndexById(projectId);
      const proj = getProjectById(projectId);
      if (!proj || projectIndex === -1) return;
      addTab(projectIndex);
    });

    const offNewAgentTab = on(Events.NEW_AGENT_TAB, (projectId: string, provider?: import('@shared/types').AgentProvider) => {
      const projectIndex = getProjectIndexById(projectId);
      const proj = getProjectById(projectId);
      if (!proj || projectIndex === -1) return;
      const resolvedProvider = resolveAgentProviderForOpen(projectId, provider);
      if (!resolvedProvider) return;
      addTab(projectIndex, undefined, undefined, undefined, 'agent', resolvedProvider);
    });

    const offNewWebTab = on(Events.NEW_WEB_TAB, (projectId: string, url?: string) => {
      const projectIndex = getProjectIndexById(projectId);
      const proj = getProjectById(projectId);
      if (!proj || projectIndex === -1) return;
      // `url` (from the + menu's granted-origin shortcuts) pre-navigates the tab;
      // absent = a blank web tab. Unnamed either way → label follows the host.
      addTab(projectIndex, undefined, undefined, undefined, 'web', undefined, url);
    });

    // browser_open (agent tool): main asks to open a Web tab navigated to `url`
    // in the agent's project, AFTER the user approved the per-call popup. addTab
    // auto-activates the new tab so the login page is front-and-center.
    const offOpenWebTab = window.shelfApi.web.onOpenTab((projectId: string, url: string) => {
      const projectIndex = projects.findIndex((p) => p.config.id === projectId);
      if (projectIndex === -1) {
        // Fail-loud: the target project vanished (closed mid-turn) — don't
        // silently drop the user's login request.
        console.warn(`[browser_open] open-tab for unknown project ${projectId} (${url})`);
        return;
      }
      addTab(projectIndex, undefined, undefined, undefined, 'web', undefined, url);
    });

    const offProposeWorktreeCreate = window.shelfApi.worktree.onProposeCreate(({ projectId, branch, notePaths }) => {
      const projectIndex = projects.findIndex((p) => p.config.id === projectId);
      if (projectIndex === -1) {
        console.warn(`[worktree] propose-create for unknown project ${projectId}`);
        return;
      }
      setActiveProjectById(projectId);
      emit(Events.CREATE_WORKTREE, projectId, { branch, notePaths });
    });

    const offProposeWorktreeFinish = window.shelfApi.worktree.onProposeFinish(({ projectId }) => {
      const projectIndex = projects.findIndex((p) => p.config.id === projectId);
      if (projectIndex === -1) {
        console.warn(`[worktree] propose-finish for unknown project ${projectId}`);
        return;
      }
      setActiveProjectById(projectId);
      emit(Events.WORKTREE_CLOSE, projectId, 'finish');
    });

    const offConnectProject = on(Events.CONNECT_PROJECT, async (projectId: string) => {
      let proj = getProjectById(projectId);
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
        proj = getProjectById(projectId);
        const projectIndex = getProjectIndexById(projectId);
        if (!proj || projectIndex === -1 || proj.tabs.length > 0) return;
        const provider = resolveAgentProviderForConnect(projectId);
        if (provider) {
          addTab(projectIndex, undefined, undefined, undefined, 'agent', provider);
        }
      }

      proj = getProjectById(projectId);
      const projectIndex = getProjectIndexById(projectId);
      if (!proj || projectIndex === -1) return;
      const templates = proj.config.defaultTabs;
      if (templates && templates.length > 0) {
        templates.forEach((t) =>
          t.kind === 'web'
            ? addTab(projectIndex, t.name, undefined, t.color, 'web', undefined, t.url)
            : addTab(projectIndex, t.name, t.cmd, t.color),
        );
      } else {
        addTab(projectIndex);
      }
      setActiveTab(projectIndex, 0);
    });

    const offDisconnectProject = on(Events.DISCONNECT_PROJECT, (projectId: string) => {
      const projectIndex = getProjectIndexById(projectId);
      const proj = getProjectById(projectId);
      if (!proj || proj.tabs.length === 0) return;
      // Was leaking: this only killed PTYs and forgot agent tabs, so an agent
      // session's exec (+ provider CLI) survived a project disconnect. Route
      // through teardownTab so agent backends are destroyed too.
      proj.tabs.forEach(teardownTab);
      // Remove all tabs but keep the project
      for (let t = proj.tabs.length - 1; t >= 0; t--) {
        removeTab(projectIndex, t);
      }
      setSplitTab(projectIndex, null);
    });

    const offAddProject = on(Events.ADD_PROJECT, async (config: ProjectConfig) => {
      addProject(config);
      const configs = getProjectConfigs();
      await window.shelfApi.project.save(configs);
    });

    // Just record the id; the store-keyed effect above connects it once it's added
    // (the setter is stable, so the stale `projects` closure here doesn't matter).
    const offAutoConnect = on(Events.AUTO_CONNECT_PROJECT, (projectId: string) => {
      setPendingConnectId(projectId);
    });

    const offToggleSplit = on(Events.TOGGLE_SPLIT, (projectId: string) => {
      const projectIndex = getProjectIndexById(projectId);
      const proj = getProjectById(projectId);
      if (!proj || projectIndex === -1) return;

      if (proj.splitTabId) {
        // Close split — kill the split tab
        const splitTab = proj.tabs.find((t) => t.id === proj.splitTabId);
        if (splitTab) {
          // Split only ever holds terminals (opened via addTab below), but guard
          // anyway so a non-terminal never gets a spurious pty.kill.
          if (splitTab.type === 'terminal') {
            window.shelfApi.pty.kill(splitTab.id);
            disposeTerminal(splitTab.id);
          }
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

    return () => { offCloseTab(); offRemoveProject(); offWorktreeFinishCompleted(); offNewTab(); offNewAgentTab(); offNewWebTab(); offOpenWebTab(); offProposeWorktreeCreate(); offProposeWorktreeFinish(); offConnectProject(); offAutoConnect(); offDisconnectProject(); offAddProject(); offToggleSplit(); offSwitchBranch(); };
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
    if (proj && activeProjectIndex !== -1) clearUnread(activeProjectIndex, proj.activeTabIndex);

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
    for (const [name, value] of Object.entries(buildThemeVars(theme))) {
      root.style.setProperty(name, value);
    }
  }, [theme]);

  const activeProject = projects[activeProjectIndex] ?? null;
  const stableProjectViews = listStableProjectViews();

  return (
    <div className="app">
      <div className="content">
      {sidebarVisible && <Sidebar />}
      <main className="main-area">
        <div className="terminal-section">
        <TabBar />
        <div className="terminal-view">
          <ProjectNoticeBanner />
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
              onClick={() => { if (activeProjectId) emit(Events.CONNECT_PROJECT, activeProjectId); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && activeProjectId) emit(Events.CONNECT_PROJECT, activeProjectId); }}
              tabIndex={0}
              ref={(el) => el?.focus()}
            >
              Click or press Enter to connect to <strong>{activeProject.config.name}</strong>
            </div>
          )}
          <div className={activeProject?.splitTabId ? 'split-view' : 'terminal-fill'}>
            {stableProjectViews.map((proj) => {
                const isActiveProject = proj.config.id === activeProjectId;
                const isSplit = isActiveProject && proj.splitTabId !== null;

                return (
                  <React.Fragment key={proj.config.id}>
                    {proj.tabs.map((tab, ti) => {
                      const isActiveTab = ti === proj.activeTabIndex;
                      const isSplitTab = tab.id === proj.splitTabId;
                      const visible = isActiveProject && (isSplit ? (isActiveTab || isSplitTab) : isActiveTab);

                      return (
                        <div
                          key={tab.id}
                          className={isSplit && visible ? 'split-pane' : undefined}
                          style={!visible ? { display: 'none' } : undefined}
                        >
                          {tab.type === 'web' ? (
                            <WebTabView
                              tabId={tab.id}
                              initialUrl={tab.url}
                              visible={visible}
                            />
                          ) : tab.type === 'agent' && tab.provider ? (
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
                    })}
                  </React.Fragment>
                );
              })}
          </div>
        </div>
        {awayMode && (
          <div className="away-mode-overlay">
            <span>Away Mode — PM is in control</span>
          </div>
        )}
        </div>
        {pmVisible && <PmView />}
        {notesVisible && <NotesView />}
        {skillsVisible && <SkillsView />}
        {mcpVisible && <McpView />}
        {devToolsVisible && <DevToolsPanel />}
      </main>
      </div>
      <BottomBar />
      <FolderPicker />
      <SettingsPanel />
      <ProjectEditPanel />
      <CommandPicker />
      <QuickNoteOverlay />
      <WorktreeDialog />
      <WorktreeCloseGate />
      <RemoveConfirmDialog />
      <WebPermissionPrompt />
      <BrowserOpenPrompt />
    </div>
  );
}
