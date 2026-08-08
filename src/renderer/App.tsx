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
import { BackupView } from './components/BackupView';
import { QuickNoteOverlay } from './components/QuickNoteOverlay';
import { useKeybindings } from './hooks/useKeybindings';
import { useStore, setSettings, setUpdateStatus, addTab, setActiveTab, removeTab, setSplitTab, clearUnread, setInvalidProjects, setPmActive, setConnectionHealth, setActiveProjectById, getProjectById, getProjectViews, getProjectIndexById, getCanonicalProjectById, reconcileProjects, listStableProjectViews, showProjectNotice, resolveAgentProviderForOpen, resolveAgentProviderForConnect } from './store';
import type { ConnectionHealth } from '@shared/types';
import type { Project, ProjectCreateInput } from '@shared/projects';
import { disposeTerminal } from './components/TerminalView';
import { teardownTab } from './tab-teardown';
import { on, emit, Events, onBackup } from './events';
import { bindAgentIPCGroup } from './events';
import { bindAgentStoreSubscriptions } from './agentTabSubscriptions';
import { setInMemoryMax, setSaveThrottleMs } from './agentTabStore';
import { getTheme, buildThemeVars } from './themes';
import { clearAgentSession } from './storage/agent-history';
import { bindProcessMemorySummary } from './process-memory-sync';
import { createProjectMutationCoordinator } from './project-mutation-coordinator';
import { createRendererProjectsRepositoryClient } from './projects-repository-client';
import { runProjectOperationWithRecovery } from './project-mutation-recovery';
import {
  acceptBackupPanelList,
  acceptImportApplyFailure,
  acceptImportApplySuccess,
  acceptImportItems,
  acceptImportSources,
  failBackupPanelRequest,
  failImportPanelRequest,
} from './backup-panel-store';
import './styles/global.css';

const projectCoordinator = createProjectMutationCoordinator(
  createRendererProjectsRepositoryClient(),
  { getProject: getCanonicalProjectById, reconcile: reconcileProjects },
);

function reportProjectMutationError(operation: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[project-coordinator] operation=${operation} failed: ${message}`);
  void window.shelfApi.dialog.warn('Project update failed', message);
}

async function confirmProjectRetry(input: {
  operation: string;
  kind: 'mutation' | 'refresh';
  error: unknown;
}): Promise<boolean> {
  const detail = input.error instanceof Error ? input.error.message : String(input.error);
  const message = input.kind === 'refresh'
    ? `The project ${input.operation} was saved, but the project list could not be refreshed. Retry refresh?\n\n${detail}`
    : `The project ${input.operation} could not be saved. Retry?\n\n${detail}`;
  try {
    return await window.shelfApi.dialog.confirm('Project update failed', message, 'Retry');
  } catch (error) {
    console.error(`[project-recovery] prompt failed operation=${input.operation}`, error);
    return false;
  }
}

function runProjectOperation<T>(operation: string, action: () => Promise<T>) {
  return runProjectOperationWithRecovery({
    operation,
    action,
    refresh: () => projectCoordinator.refresh(),
    confirmRetry: confirmProjectRetry,
  });
}

async function recoverProjectCleanup(projectId: string, cleanupPending: boolean) {
  let pending = cleanupPending;
  while (pending) {
    const retry = await window.shelfApi.dialog.confirm(
      'Project removed with leftover data',
      'The project was removed, but some project storage or secrets could not be cleaned up. Retry cleanup?',
      'Retry',
    ).catch((error) => {
      console.error(`[project-cleanup] prompt failed projectId=${projectId}`, error);
      return false;
    });
    if (!retry) return;
    const recovered = await runProjectOperation('cleanup', () => projectCoordinator.retryCleanup(projectId));
    if (recovered.status === 'cancelled') return;
    pending = recovered.value.cleanupPending;
  }
}

export function App() {
  const { projects, activeProjectIndex, activeProjectId, sidebarVisible, settingsVisible, commandPickerVisible, devToolsVisible, notesVisible, skillsVisible, mcpVisible, backupVisible, editingProjectIndex, settings, pmVisible, awayMode } = useStore();
  useKeybindings();

  // Auto-connect a just-added project (e.g. a fresh worktree) once it lands in the
  // store. Driven off `projects` (fresh) so the CONNECT_PROJECT handler — which
  // indexes the same fresh snapshot — resolves the new project; emitting inside a
  // bus handler right after ADD_PROJECT would hit the pre-add closure instead.
  const [pendingConnectId, setPendingConnectId] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingConnectId) return;
    const idx = projects.findIndex((p) => p.id === pendingConnectId);
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

  // Backup panel intents cross the renderer→main boundary here. The view owns
  // rendering only; session/request revisions prevent a closed or superseded
  // panel from accepting a late IPC completion.
  useEffect(() => {
    const logStale = (operation: string, sessionRevision: number, requestRevision: number) => {
      window.shelfApi.app.debugLog(
        'config-backup',
        `discarded stale ${operation} result (session=${sessionRevision}, request=${requestRevision})`,
      );
    };
    const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

    const offLoad = onBackup('backup:load-local', async (token) => {
      try {
        const result = await window.shelfApi.configBackup.list();
        if (!acceptBackupPanelList(token, result)) {
          logStale('load-local', token.sessionRevision, token.requestRevision);
        }
      } catch (error) {
        if (!failBackupPanelRequest(token, messageOf(error))) {
          logStale('load-local failure', token.sessionRevision, token.requestRevision);
        }
      }
    });

    const offSave = onBackup('backup:save-settings', async ({ settings: nextSettings, ...token }) => {
      try {
        await window.shelfApi.configBackup.saveSettings(nextSettings);
        const result = await window.shelfApi.configBackup.list();
        if (!acceptBackupPanelList(token, result)) {
          logStale('save-settings', token.sessionRevision, token.requestRevision);
        }
      } catch (error) {
        if (!failBackupPanelRequest(token, messageOf(error))) {
          logStale('save-settings failure', token.sessionRevision, token.requestRevision);
        }
      }
    });

    const offRun = onBackup('backup:run', async ({ selectedIds, ...token }) => {
      try {
        const result = await window.shelfApi.configBackup.run(selectedIds);
        if (!result.ok) {
          if (!failBackupPanelRequest(token, result.message)) {
            logStale('run failure', token.sessionRevision, token.requestRevision);
          }
          return;
        }
        const list = await window.shelfApi.configBackup.list();
        const status = result.pushed
          ? `Backed up ${result.itemCount} item${result.itemCount === 1 ? '' : 's'}.`
          : 'Selected items are already up to date.';
        if (!acceptBackupPanelList(token, list, status)) {
          logStale('run', token.sessionRevision, token.requestRevision);
        }
      } catch (error) {
        if (!failBackupPanelRequest(token, messageOf(error))) {
          logStale('run failure', token.sessionRevision, token.requestRevision);
        }
      }
    });

    const offFindImportSources = onBackup(
      'backup:find-import-sources',
      async ({ remoteUrl, ...token }) => {
        try {
          const sources = await window.shelfApi.configBackup.listSources(remoteUrl);
          if (!acceptImportSources(token, sources)) {
            logStale('find-import-sources', token.sessionRevision, token.requestRevision);
          }
        } catch (error) {
          if (!failImportPanelRequest(token, messageOf(error))) {
            logStale('find-import-sources failure', token.sessionRevision, token.requestRevision);
          }
        }
      },
    );

    const offLoadImportSource = onBackup(
      'backup:load-import-source',
      async ({ remoteUrl, sourceRevision, ...token }) => {
        try {
          const result = await window.shelfApi.configBackup.listImportItems(remoteUrl, sourceRevision);
          if (!acceptImportItems(token, result)) {
            logStale('load-import-source', token.sessionRevision, token.requestRevision);
          }
        } catch (error) {
          if (!failImportPanelRequest(token, messageOf(error))) {
            logStale('load-import-source failure', token.sessionRevision, token.requestRevision);
          }
        }
      },
    );

    const offApplyImport = onBackup(
      'backup:apply-import',
      async ({ remoteUrl, sourceRevision, selectedIds, ...token }) => {
        try {
          const result = await window.shelfApi.configBackup.applyImport(
            remoteUrl,
            sourceRevision,
            selectedIds,
          );
          if (!result.ok) {
            if (!acceptImportApplyFailure(token, result)) {
              logStale('apply-import failure', token.sessionRevision, token.requestRevision);
            }
            return;
          }

          let refreshed = null;
          let refreshError: string | undefined;
          try {
            refreshed = await window.shelfApi.configBackup.listImportItems(remoteUrl, sourceRevision);
          } catch (error) {
            refreshError = `Import succeeded, but impact refresh failed: ${messageOf(error)}`;
          }
          if (!acceptImportApplySuccess(token, result, refreshed, selectedIds.length, refreshError)) {
            logStale('apply-import', token.sessionRevision, token.requestRevision);
          }
        } catch (error) {
          if (!failImportPanelRequest(token, messageOf(error))) {
            logStale('apply-import rejection', token.sessionRevision, token.requestRevision);
          }
        }
      },
    );

    return () => {
      offLoad();
      offSave();
      offRun();
      offFindImportSources();
      offLoadImportSource();
      offApplyImport();
    };
  }, []);

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

    const offRemoveProject = on(Events.REMOVE_PROJECT, async (projectId: string) => {
      const projectIndex = getProjectIndexById(projectId);
      const proj = getProjectById(projectId);
      if (projectIndex === -1 || !proj) return;
      const deleted = await runProjectOperation('delete', () => projectCoordinator.delete(projectId));
      if (deleted.status === 'cancelled') return;
      Object.values(proj.agentSessionIds).forEach((id) => { if (id) clearAgentSession(id); });
      proj.tabs.forEach(teardownTab);
      await recoverProjectCleanup(projectId, deleted.value.cleanupPending);
    });

    const offWorktreeFinishCompleted = on(Events.WORKTREE_FINISH_COMPLETED, (payload: {
      subProjectId: string;
      parentProjectId: string;
      featureBranch: string;
      targetBranch: string;
    }) => {
      const configsAfter = getProjectViews()
        .filter((p) => p.id !== payload.subProjectId);
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
      const projectIndex = getProjectIndexById(projectId);
      if (projectIndex === -1) {
        // Fail-loud: the target project vanished (closed mid-turn) — don't
        // silently drop the user's login request.
        console.warn(`[browser_open] open-tab for unknown project ${projectId} (${url})`);
        return;
      }
      addTab(projectIndex, undefined, undefined, undefined, 'web', undefined, url);
    });

    const offProposeWorktreeCreate = window.shelfApi.worktree.onProposeCreate(({ projectId, branch, notePaths }) => {
      const projectIndex = getProjectIndexById(projectId);
      if (projectIndex === -1) {
        console.warn(`[worktree] propose-create for unknown project ${projectId}`);
        return;
      }
      setActiveProjectById(projectId);
      emit(Events.CREATE_WORKTREE, projectId, { branch, notePaths });
    });

    const offProposeWorktreeFinish = window.shelfApi.worktree.onProposeFinish(({ projectId }) => {
      const projectIndex = getProjectIndexById(projectId);
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
      const conn = proj.connection;
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

      if (proj.openAgentOnConnect) {
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
      const templates = proj.defaultTabs;
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

    const offAddProject = on(Events.ADD_PROJECT, async (
      input: ProjectCreateInput,
      onSettled?: (result: { ok: true; project: Project } | { ok: false; error: unknown }) => void,
    ) => {
      const added = await runProjectOperation('add', () => projectCoordinator.add(input));
      if (added.status === 'cancelled') {
        onSettled?.({ ok: false, error: added.error });
        return;
      }
      setActiveProjectById(added.value.id);
      onSettled?.({ ok: true, project: added.value });
    });

    const offUpdateProject = on(Events.UPDATE_PROJECT, async (
      projectId: string,
      changes: Partial<Omit<Project, 'id'>>,
    ) => {
      await runProjectOperation('update', () => projectCoordinator.save(projectId, changes));
    });

    const offReorderProjects = on(Events.REORDER_PROJECTS, async (sourceId: string, targetId: string) => {
      await runProjectOperation('reorder', () => projectCoordinator.reorder(sourceId, targetId));
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
      const proj = getProjectViews()[projectIndex];
      if (!proj) { callback(false); return; }

      const result = await window.shelfApi.git.checkout(proj.connection, proj.cwd, branch);
      if (result.ok) {
        callback(true, branch);
      } else {
        void window.shelfApi.dialog.warn('Branch switch failed', result.error ?? 'Unknown error');
        callback(false);
      }
    });

    return () => { offCloseTab(); offRemoveProject(); offWorktreeFinishCompleted(); offNewTab(); offNewAgentTab(); offNewWebTab(); offOpenWebTab(); offProposeWorktreeCreate(); offProposeWorktreeFinish(); offConnectProject(); offAutoConnect(); offDisconnectProject(); offAddProject(); offUpdateProject(); offReorderProjects(); offToggleSplit(); offSwitchBranch(); };
  }, []);

  useEffect(() => {
    projectCoordinator.initialize()
      .then(() => projectCoordinator.getInvalidDirectoryIds())
      .then(setInvalidProjects)
      .catch((error) => reportProjectMutationError('initialize', error));
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
              <span className="invalid-folder-path">{activeProject.cwd}</span>
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
              Click or press Enter to connect to <strong>{activeProject.name}</strong>
            </div>
          )}
          <div className={activeProject?.splitTabId ? 'split-view' : 'terminal-fill'}>
            {stableProjectViews.map((proj) => {
                const isActiveProject = proj.id === activeProjectId;
                const isSplit = isActiveProject && proj.splitTabId !== null;

                return (
                  <React.Fragment key={proj.id}>
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
                              cwd={proj.cwd}
                              connection={proj.connection}
                              provider={tab.provider}
                              projectId={proj.id}
                              visible={visible}
                            />
                          ) : (
                            <TerminalView
                              tabId={tab.id}
                              projectId={proj.id}
                              cwd={proj.cwd}
                              connection={proj.connection}
                              initScript={proj.initScript ?? undefined}
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
        {backupVisible && <BackupView />}
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
