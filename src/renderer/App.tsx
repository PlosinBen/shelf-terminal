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
import { useKeybindings } from './hooks/useKeybindings';
import { useStore, setProjects, setSettings, setUpdateStatus, addProject, addTab, setActiveTab, removeTab, removeProject, setSplitTab, toggleSidebar, clearUnread, setInvalidProjects, setTabProvider, updateAgentState, addAgentMessage, updateAgentMessage, filterAgentMessages, deleteAgentState, getAgentState, updateProjectConfig } from './store';
import type { ProjectConfig, AgentProvider } from '@shared/types';
import { disposeTerminal } from './components/TerminalView';
import { on, emit, Events } from './events';
import { getTheme } from './themes';
import { rotateOldMessages, loadMessages, saveMessage } from './agent-history';
import type { AgentMsg } from './components/AgentMessage';
import './styles/global.css';

export function App() {
  const { projects, activeProjectIndex, sidebarVisible, settingsVisible, commandPickerVisible, devToolsVisible, editingProjectIndex, settings } = useStore();
  useKeybindings();

  useEffect(() => {
    window.shelfApi.settings.load().then(setSettings);
    rotateOldMessages(30);
  }, []);

  useEffect(() => {
    return window.shelfApi.updater.onStatus(setUpdateStatus);
  }, []);

  // ── Centralized agent IPC listeners ──
  useEffect(() => {
    let msgCounter = 0;
    const nextId = () => `msg-${Date.now()}-${++msgCounter}`;

    const persistMsg = (projectId: string, provider: string | undefined, role: string, type: string, content: string, extra?: { toolName?: string; toolUseId?: string; toolInput?: Record<string, unknown> }) => {
      saveMessage({
        projectId, timestamp: Date.now(), role: role as any, type: type as any, content, provider,
        toolName: extra?.toolName, toolUseId: extra?.toolUseId,
        toolInput: extra?.toolInput ? JSON.stringify(extra.toolInput) : undefined,
      });
    };

    const findProjectForTab = (tabId: string) => {
      for (const proj of projects) {
        const tab = proj.tabs.find((t) => t.id === tabId);
        if (tab) return { proj, tab };
      }
      return null;
    };

    const streamingText = new Map<string, string>();
    const streamingIds = new Map<string, string>();

    const offMessage = window.shelfApi.agent.onMessage((payload) => {
      const info = findProjectForTab(payload.tabId);
      if (!info) return;
      const { tabId } = payload;
      const provider = info.tab.provider;

      if (payload.type === 'text') {
        streamingIds.delete(tabId);
        streamingText.delete(tabId);
        const id = nextId();
        filterAgentMessages(tabId, (m) => !m.streaming || m.type !== 'text');
        addAgentMessage(tabId, { id, role: 'assistant', type: 'text', content: payload.content, provider });
        persistMsg(info.proj.config.id, provider, 'assistant', 'text', payload.content);
      } else if (payload.type === 'thinking') {
        addAgentMessage(tabId, { id: nextId(), role: 'assistant', type: 'thinking', content: payload.content });
        persistMsg(info.proj.config.id, provider, 'assistant', 'thinking', payload.content);
      } else if (payload.type === 'tool_use') {
        addAgentMessage(tabId, { id: nextId(), role: 'tool', type: 'tool_use', content: '', toolName: payload.toolName, toolInput: payload.toolInput, toolUseId: payload.toolUseId, streaming: true, cwd: info.proj.config.cwd });
        persistMsg(info.proj.config.id, provider, 'tool', 'tool_use', '', { toolName: payload.toolName, toolUseId: payload.toolUseId, toolInput: payload.toolInput });
      } else if (payload.type === 'tool_result') {
        updateAgentMessage(tabId, (m) => m.toolUseId === payload.toolUseId && m.type === 'tool_use', (m) => ({ ...m, streaming: false, toolResult: payload.content }));
        persistMsg(info.proj.config.id, provider, 'tool', 'tool_result', payload.content, { toolUseId: payload.toolUseId });
      } else if (payload.type === 'system') {
        addAgentMessage(tabId, { id: nextId(), role: 'system', type: 'system', content: payload.content });
      } else if (payload.type === 'result') {
        streamingIds.delete(tabId);
        filterAgentMessages(tabId, (m) => !m.streaming);
      } else if (payload.type === 'error') {
        updateAgentState(tabId, { streaming: false, agentStatus: 'idle' });
        addAgentMessage(tabId, { id: nextId(), role: 'system', type: 'error', content: payload.content });
      }
    });

    const offStream = window.shelfApi.agent.onStream((payload) => {
      const { tabId } = payload;
      if (payload.type === 'text') {
        const text = (streamingText.get(tabId) ?? '') + payload.content;
        streamingText.set(tabId, text);
        let id = streamingIds.get(tabId);
        if (!id) { id = nextId(); streamingIds.set(tabId, id); }
        const info = findProjectForTab(tabId);
        const provider = info?.tab.provider;
        const state = getAgentState(tabId);
        const existing = state.messages.findIndex((m) => m.id === id);
        const msg: AgentMsg = { id: id!, role: 'assistant', type: 'text', content: text, provider, streaming: true };
        if (existing >= 0) {
          updateAgentMessage(tabId, (m) => m.id === id, () => msg);
        } else {
          addAgentMessage(tabId, msg);
        }
      }
    });

    const offStatus = window.shelfApi.agent.onStatus((payload) => {
      const { tabId } = payload;
      const isStreaming = payload.state === 'streaming';
      const state = getAgentState(tabId);

      const updates: Partial<typeof state> = {
        streaming: isStreaming,
        agentStatus: isStreaming ? 'running' : 'idle',
      };

      if (payload.model) updates.model = payload.model;
      if (payload.costUsd !== undefined) updates.cost = payload.costUsd;
      if (payload.inputTokens !== undefined || payload.outputTokens !== undefined) {
        updates.tokens = { input: payload.inputTokens ?? state.tokens.input, output: payload.outputTokens ?? state.tokens.output };
      }
      if ((payload as any).contextUsedTokens != null && (payload as any).contextWindow) {
        updates.contextInfo = { used: (payload as any).contextUsedTokens, window: (payload as any).contextWindow };
      }
      if ((payload as any).rateLimit) {
        const rl = (payload as any).rateLimit;
        updates.rateLimit = { type: rl.rateLimitType, utilization: rl.utilization, resetsAt: rl.resetsAt };
      }

      updateAgentState(tabId, updates);

      if (!isStreaming && state.queuedMessages.length > 0) {
        const next = state.queuedMessages[0];
        updateAgentState(tabId, { queuedMessages: state.queuedMessages.slice(1) });
        const info = findProjectForTab(tabId);
        if (info?.tab.provider) {
          setTimeout(() => window.shelfApi.agent.send(tabId, next.content, info.proj.config.cwd, info.tab.provider!, info.proj.config.connection, info.proj.config.initScript), 100);
        }
      }

      if (payload.sessionId) {
        const info = findProjectForTab(tabId);
        if (info?.tab.provider) {
          const projIdx = projects.indexOf(info.proj);
          if (projIdx >= 0) {
            updateProjectConfig(projIdx, {
              agentSessionIds: { ...(info.proj.config.agentSessionIds ?? {}), [info.tab.provider]: payload.sessionId },
            });
          }
        }
      }

    });

    const offPermission = window.shelfApi.agent.onPermissionRequest((payload) => {
      updateAgentState(payload.tabId, { pendingPermission: { toolUseId: payload.toolUseId, toolName: payload.toolName, input: payload.input } });
    });

    const offCapabilities = window.shelfApi.agent.onCapabilities((payload) => {
      const updates: any = { capabilities: { models: payload.models, permissionModes: payload.permissionModes, effortLevels: payload.effortLevels, authMethod: payload.authMethod } };
      if (payload.slashCommands.length > 0) updates.slashCommands = payload.slashCommands;
      if (payload.currentModel) updates.model = payload.currentModel;
      if (payload.currentEffort) updates.currentEffort = payload.currentEffort;
      if (payload.currentPermissionMode) updates.permissionMode = payload.currentPermissionMode;
      updateAgentState(payload.tabId, updates);
    });

    const offAuthRequired = window.shelfApi.agent.onAuthRequired((payload) => {
      updateAgentState(payload.tabId, {
        authRequired: { provider: payload.provider },
        streaming: false,
        agentStatus: 'idle',
      });
    });

    return () => { offMessage(); offStream(); offStatus(); offPermission(); offCapabilities(); offAuthRequired(); };
  }, [projects]);

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
        proj.tabs.forEach((tab) => {
          if (tab.type !== 'agent') {
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

    const offNewAgentTab = on(Events.NEW_AGENT_TAB, (projectIndex: number, provider?: AgentProvider) => {
      const proj = projects[projectIndex];
      if (!proj) return;
      const resolvedProvider = provider ?? proj.config.defaultAgentProvider;
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

      // Agent tab goes first when auto-open is enabled, so the project lands
      // on it and terminals occupy slots 1+.
      if (proj.config.openAgentOnConnect) {
        addTab(projectIndex, undefined, undefined, undefined, 'agent', proj.config.defaultAgentProvider);
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
        if (tab.type !== 'agent') {
          window.shelfApi.pty.kill(tab.id);
          disposeTerminal(tab.id);
        }
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
                      {tab.type === 'agent' ? (
                        <AgentView
                          tabId={tab.id}
                          projectId={proj.config.id}
                          projectIndex={pi}
                          cwd={proj.config.cwd}
                          connection={proj.config.connection}
                          initScript={proj.config.initScript}
                          provider={tab.provider}
                          visible={visible}
                          onSelectProvider={setTabProvider}
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
        </div>
        <DevToolsPanel />
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
