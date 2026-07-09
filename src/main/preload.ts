import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/ipc-channels';

contextBridge.exposeInMainWorld('shelfApi', {
  pty: {
    spawn: (projectId: string, tabId: string, cwd: string, connection: unknown, initScript?: string, tabCmd?: string) =>
      ipcRenderer.invoke(IPC.PTY_SPAWN, { projectId, tabId, cwd, connection, initScript, tabCmd }),
    input: (tabId: string, data: string) =>
      ipcRenderer.send(IPC.PTY_INPUT, { tabId, data }),
    resize: (tabId: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC.PTY_RESIZE, { tabId, cols, rows }),
    kill: (tabId: string) =>
      ipcRenderer.invoke(IPC.PTY_KILL, { tabId }),
    mute: (tabId: string, muted: boolean) =>
      ipcRenderer.send(IPC.PTY_MUTE, { tabId, muted }),
    onData: (callback: (tabId: string, data: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { tabId: string; data: string }) => {
        callback(payload.tabId, payload.data);
      };
      ipcRenderer.on(IPC.PTY_DATA, listener);
      return () => ipcRenderer.removeListener(IPC.PTY_DATA, listener);
    },
    onExit: (callback: (tabId: string, exitCode: number) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { tabId: string; exitCode: number }) => {
        callback(payload.tabId, payload.exitCode);
      };
      ipcRenderer.on(IPC.PTY_EXIT, listener);
      return () => ipcRenderer.removeListener(IPC.PTY_EXIT, listener);
    },
    onInitSent: (callback: (tabId: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { tabId: string }) => {
        callback(payload.tabId);
      };
      ipcRenderer.on(IPC.PTY_INIT_SENT, listener);
      return () => ipcRenderer.removeListener(IPC.PTY_INIT_SENT, listener);
    },
  },
  connector: {
    listDir: (connection: any, dirPath: string) =>
      ipcRenderer.invoke(IPC.CONNECTOR_LIST_DIR, { connection, path: dirPath }),
    homePath: (connection: any) =>
      ipcRenderer.invoke(IPC.CONNECTOR_HOME_PATH, connection),
    isConnected: (connection: any) =>
      ipcRenderer.invoke(IPC.CONNECTOR_CHECK, connection),
    connect: (connection: any, password?: string) =>
      ipcRenderer.invoke(IPC.CONNECTOR_ESTABLISH, { connection, password }),
    availableTypes: () =>
      ipcRenderer.invoke(IPC.CONNECTOR_AVAILABLE_TYPES),
    uploadFile: (connection: any, cwd: string, filename: string, buffer: ArrayBuffer) =>
      ipcRenderer.invoke(IPC.FILE_UPLOAD, { connection, cwd, filename, buffer }),
    clearUploads: (connection: any, cwd: string) =>
      ipcRenderer.invoke(IPC.FILE_CLEAR_UPLOADS, { connection, cwd }),
    getUploadsSize: (connection: any, cwd: string): Promise<{ totalBytes: number; fileCount: number }> =>
      ipcRenderer.invoke(IPC.FILE_UPLOADS_SIZE, { connection, cwd }),
  },
  project: {
    load: () => ipcRenderer.invoke(IPC.PROJECT_LOAD),
    save: (projects: unknown) => ipcRenderer.invoke(IPC.PROJECT_SAVE, projects),
    validateDirs: (projects: unknown) => ipcRenderer.invoke(IPC.PROJECT_VALIDATE_DIRS, projects),
    // Secret env: renderer sends key/value to set, only ever reads back KEY names.
    listSecretKeys: (projectId: string) => ipcRenderer.invoke(IPC.PROJECT_SECRETS_LIST, projectId),
    setSecret: (projectId: string, key: string, value: string) => ipcRenderer.invoke(IPC.PROJECT_SECRET_SET, projectId, key, value),
    deleteSecret: (projectId: string, key: string) => ipcRenderer.invoke(IPC.PROJECT_SECRET_DELETE, projectId, key),
    secretKeyTier: () => ipcRenderer.invoke(IPC.SECRET_KEY_TIER),
  },
  dialog: {
    warn: (title: string, message: string) =>
      ipcRenderer.invoke(IPC.DIALOG_WARN, { title, message }),
    confirm: (title: string, message: string, confirmLabel?: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.DIALOG_CONFIRM, { title, message, confirmLabel }),
  },
  docker: {
    listContainers: () =>
      ipcRenderer.invoke(IPC.DOCKER_LIST_CONTAINERS),
  },
  wsl: {
    listDistros: () =>
      ipcRenderer.invoke(IPC.WSL_LIST_DISTROS),
  },
  ssh: {
    removeHostKey: (host: string, port: number) =>
      ipcRenderer.invoke(IPC.SSH_REMOVE_HOST_KEY, { host, port }),
    servers: () =>
      ipcRenderer.invoke(IPC.SSH_SERVERS),
  },
  git: {
    branchList: (connection: any, cwd: string) =>
      ipcRenderer.invoke(IPC.GIT_BRANCH_LIST, { connection, cwd }),
    checkDirty: (connection: any, cwd: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.GIT_CHECK_DIRTY, { connection, cwd }),
    checkout: (connection: any, cwd: string, branch: string): Promise<void> =>
      ipcRenderer.invoke(IPC.GIT_CHECKOUT, { connection, cwd, branch }),
    worktreeAdd: (connection: any, cwd: string, branch: string, newBranch: boolean) =>
      ipcRenderer.invoke(IPC.GIT_WORKTREE_ADD, { connection, cwd, branch, newBranch }),
    worktreeRemove: (connection: any, cwd: string, worktreePath: string) =>
      ipcRenderer.invoke(IPC.GIT_WORKTREE_REMOVE, { connection, cwd, worktreePath }),
  },
  settings: {
    load: () => ipcRenderer.invoke(IPC.SETTINGS_LOAD),
    save: (settings: unknown) => ipcRenderer.invoke(IPC.SETTINGS_SAVE, settings),
  },
  logs: {
    clear: () => ipcRenderer.invoke(IPC.LOGS_CLEAR),
    size: (): Promise<{ totalBytes: number; fileCount: number }> =>
      ipcRenderer.invoke(IPC.LOGS_SIZE),
  },
  notes: {
    list: (projectId: string) => ipcRenderer.invoke(IPC.NOTES_LIST, projectId),
    get: (projectId: string, noteId: string) =>
      ipcRenderer.invoke(IPC.NOTES_GET, { projectId, noteId }),
    create: (projectId: string) => ipcRenderer.invoke(IPC.NOTES_CREATE, projectId),
    quickCreate: (projectId: string, body: string, images: string[] = []) =>
      ipcRenderer.invoke(IPC.NOTES_QUICK_CREATE, { projectId, body, images }),
    update: (projectId: string, noteId: string, patch: { title?: string; isDone?: boolean; body?: string; images?: string[] }) =>
      ipcRenderer.invoke(IPC.NOTES_UPDATE, { projectId, noteId, patch }),
    delete: (projectId: string, noteId: string) =>
      ipcRenderer.invoke(IPC.NOTES_DELETE, { projectId, noteId }),
    deleteAllDone: (projectId: string): Promise<number> =>
      ipcRenderer.invoke(IPC.NOTES_DELETE_ALL_DONE, projectId),
    saveImage: (projectId: string, buffer: ArrayBuffer, ext: string): Promise<string> =>
      ipcRenderer.invoke(IPC.NOTES_SAVE_IMAGE, { projectId, buffer, ext }),
    readImage: (projectId: string, filename: string): Promise<ArrayBuffer | null> =>
      ipcRenderer.invoke(IPC.NOTES_READ_IMAGE, { projectId, filename }),
  },
  skills: {
    list: () => ipcRenderer.invoke(IPC.SKILLS_LIST),
    get: (name: string) => ipcRenderer.invoke(IPC.SKILLS_GET, name),
    create: () => ipcRenderer.invoke(IPC.SKILLS_CREATE),
    update: (name: string, content: string) =>
      ipcRenderer.invoke(IPC.SKILLS_UPDATE, { name, content }),
    delete: (name: string) => ipcRenderer.invoke(IPC.SKILLS_DELETE, name),
    setLocked: (name: string, locked: boolean) =>
      ipcRenderer.invoke(IPC.SKILLS_SET_LOCKED, { name, locked }),
    listFiles: (name: string) => ipcRenderer.invoke(IPC.SKILLS_LIST_FILES, name),
    readFile: (name: string, path: string) =>
      ipcRenderer.invoke(IPC.SKILLS_READ_FILE, { name, path }),
    writeFile: (name: string, path: string, content: string) =>
      ipcRenderer.invoke(IPC.SKILLS_WRITE_FILE, { name, path, content }),
    deleteFile: (name: string, path: string) =>
      ipcRenderer.invoke(IPC.SKILLS_DELETE_FILE, { name, path }),
    onChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC.SKILLS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC.SKILLS_CHANGED, listener);
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke(IPC.MCP_LIST),
    get: (name: string) => ipcRenderer.invoke(IPC.MCP_GET, name),
    add: (name: string, block: unknown) => ipcRenderer.invoke(IPC.MCP_ADD, { name, block }),
    update: (name: string, block: unknown, nextName?: string) =>
      ipcRenderer.invoke(IPC.MCP_UPDATE, { name, block, nextName }),
    remove: (name: string) => ipcRenderer.invoke(IPC.MCP_REMOVE, name),
    onChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC.MCP_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC.MCP_CHANGED, listener);
    },
  },
  configBackup: {
    getBinding: () => ipcRenderer.invoke(IPC.CONFIG_BACKUP_GET_BINDING),
    bind: (binding: { remoteUrl: string; machineLabel: string }) =>
      ipcRenderer.invoke(IPC.CONFIG_BACKUP_BIND, binding),
    unbind: () => ipcRenderer.invoke(IPC.CONFIG_BACKUP_UNBIND),
    list: () => ipcRenderer.invoke(IPC.CONFIG_BACKUP_LIST),
    run: (selectedIds: string[]) => ipcRenderer.invoke(IPC.CONFIG_BACKUP_RUN, selectedIds),
    listSources: () => ipcRenderer.invoke(IPC.CONFIG_BACKUP_LIST_SOURCES),
    listImportItems: (ref: string) => ipcRenderer.invoke(IPC.CONFIG_BACKUP_LIST_IMPORT_ITEMS, ref),
    planImport: (ref: string, ids: string[]) => ipcRenderer.invoke(IPC.CONFIG_BACKUP_PLAN_IMPORT, { ref, ids }),
    applyImport: (ref: string, decisions: unknown) =>
      ipcRenderer.invoke(IPC.CONFIG_BACKUP_APPLY_IMPORT, { ref, decisions }),
  },
  app: {
    logsPath: (): Promise<string> => ipcRenderer.invoke(IPC.APP_LOGS_PATH),
    debugLog: (tag: string, msg: string): void => ipcRenderer.send(IPC.APP_DEBUG_LOG, tag, msg),
  },
  find: {
    query: (text: string, opts: { forward: boolean; findNext: boolean }): void =>
      ipcRenderer.send(IPC.WINDOW_FIND, { text, forward: opts.forward, findNext: opts.findNext }),
    stop: (): void => ipcRenderer.send(IPC.WINDOW_STOP_FIND),
    onResult: (callback: (result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => callback(result);
      ipcRenderer.on(IPC.WINDOW_FIND_RESULT, listener);
      return () => ipcRenderer.removeListener(IPC.WINDOW_FIND_RESULT, listener);
    },
  },
  web: {
    listSessions: () => ipcRenderer.invoke(IPC.WEB_LIST_SESSIONS),
    deleteSession: (domain: string) => ipcRenderer.invoke(IPC.WEB_DELETE_SESSION, domain),
    listGrants: () => ipcRenderer.invoke(IPC.WEB_LIST_GRANTS),
    revokeGrant: (projectId: string, origin: string) =>
      ipcRenderer.invoke(IPC.WEB_REVOKE_GRANT, { projectId, origin }),
    onPermissionRequest: (callback: (req: { requestId: string; origin: string; registrableDomain: string | null; method: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, req: any) => callback(req);
      ipcRenderer.on(IPC.WEB_PERMISSION_REQUEST, listener);
      return () => ipcRenderer.removeListener(IPC.WEB_PERMISSION_REQUEST, listener);
    },
    resolvePermission: (requestId: string, decision: 'once' | 'always' | 'deny') =>
      ipcRenderer.invoke(IPC.WEB_PERMISSION_RESOLVE, { requestId, decision }),
    onPermissionClose: (callback: (requestId: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { requestId: string }) => callback(payload.requestId);
      ipcRenderer.on(IPC.WEB_PERMISSION_CLOSE, listener);
      return () => ipcRenderer.removeListener(IPC.WEB_PERMISSION_CLOSE, listener);
    },
    // browser_open: per-call Open/Deny confirm (never remembered).
    onBrowserOpenRequest: (callback: (req: { requestId: string; url: string; origin: string; registrableDomain: string | null; reason?: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, req: any) => callback(req);
      ipcRenderer.on(IPC.WEB_BROWSER_OPEN_REQUEST, listener);
      return () => ipcRenderer.removeListener(IPC.WEB_BROWSER_OPEN_REQUEST, listener);
    },
    resolveBrowserOpen: (requestId: string, decision: 'open' | 'deny') =>
      ipcRenderer.invoke(IPC.WEB_BROWSER_OPEN_RESOLVE, { requestId, decision }),
    onBrowserOpenClose: (callback: (requestId: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { requestId: string }) => callback(payload.requestId);
      ipcRenderer.on(IPC.WEB_BROWSER_OPEN_CLOSE, listener);
      return () => ipcRenderer.removeListener(IPC.WEB_BROWSER_OPEN_CLOSE, listener);
    },
    // main→renderer: open a Web tab (in projectId) navigated to url (post-approval).
    onOpenTab: (callback: (projectId: string, url: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { projectId: string; url: string }) => callback(payload.projectId, payload.url);
      ipcRenderer.on(IPC.WEB_OPEN_TAB, listener);
      return () => ipcRenderer.removeListener(IPC.WEB_OPEN_TAB, listener);
    },
  },
  pm: {
    send: (message: string) => ipcRenderer.invoke(IPC.PM_SEND, message),
    stop: () => ipcRenderer.invoke(IPC.PM_STOP),
    history: () => ipcRenderer.invoke(IPC.PM_HISTORY),
    clear: () => ipcRenderer.invoke(IPC.PM_CLEAR),
    compact: () => ipcRenderer.invoke(IPC.PM_COMPACT) as Promise<{ kept: number; removed: number }>,
    syncState: (state: any) => ipcRenderer.send(IPC.PM_SYNC_STATE, state),
    setAwayMode: (on: boolean) => ipcRenderer.invoke(IPC.PM_AWAY_MODE, on),
    getAwayMode: () => ipcRenderer.invoke(IPC.PM_AWAY_MODE_GET) as Promise<boolean>,
    listModels: (baseURL: string) =>
      ipcRenderer.invoke(IPC.PM_LIST_MODELS, baseURL) as Promise<import('../shared/types').PmListModelsResult>,
    onAwayMode: (callback: (on: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, on: boolean) => callback(on);
      ipcRenderer.on(IPC.PM_AWAY_MODE, listener);
      return () => ipcRenderer.removeListener(IPC.PM_AWAY_MODE, listener);
    },
    setActive: (on: boolean) => ipcRenderer.invoke(IPC.PM_SET_ACTIVE, on),
    getActive: () => ipcRenderer.invoke(IPC.PM_ACTIVE_GET) as Promise<boolean>,
    onActive: (callback: (on: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, on: boolean) => callback(on);
      ipcRenderer.on(IPC.PM_ACTIVE, listener);
      return () => ipcRenderer.removeListener(IPC.PM_ACTIVE, listener);
    },
    onActiveError: (callback: (reason: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, reason: string) => callback(reason);
      ipcRenderer.on(IPC.PM_ACTIVE_ERROR, listener);
      return () => ipcRenderer.removeListener(IPC.PM_ACTIVE_ERROR, listener);
    },
    onStream: (callback: (chunk: import('../shared/types').PmStreamChunk) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, chunk: import('../shared/types').PmStreamChunk) => {
        callback(chunk);
      };
      ipcRenderer.on(IPC.PM_STREAM, listener);
      return () => ipcRenderer.removeListener(IPC.PM_STREAM, listener);
    },
  },
  agent: {
    init: (tabId: string, cwd: string, connection: unknown, provider: string, sessionId?: string, opts?: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.AGENT_INIT, { tabId, cwd, connection, provider, sessionId, ...opts }),
    send: (tabId: string, prompt: string, images?: string[], prefs?: { model?: string; effort?: string; permissionMode?: string; configEdit?: { key: 'model' | 'effort' | 'permissionMode'; value: string }; clientMsgId?: string }) =>
      ipcRenderer.invoke(IPC.AGENT_SEND, { tabId, prompt, images, ...prefs }),
    stop: (tabId: string) =>
      ipcRenderer.invoke(IPC.AGENT_STOP, { tabId }),
    cancelQueued: (tabId: string, clientMsgId: string) =>
      ipcRenderer.invoke(IPC.AGENT_CANCEL_QUEUED, { tabId, clientMsgId }),
    destroy: (tabId: string) =>
      ipcRenderer.invoke(IPC.AGENT_DESTROY, { tabId }),
    resolvePermission: (tabId: string, toolUseId: string, allow: boolean, scope?: 'once' | 'session') =>
      ipcRenderer.invoke(IPC.AGENT_RESOLVE_PERMISSION, { tabId, toolUseId, allow, scope }),
    resolvePicker: (
      tabId: string,
      pickerId: string,
      payload: { answers: Array<string | string[]> } | { cancelled: true },
    ) => ipcRenderer.invoke(IPC.AGENT_RESOLVE_PICKER, { tabId, pickerId, payload }),
    storeCredential: (tabId: string, key: string) =>
      ipcRenderer.invoke(IPC.AGENT_STORE_CREDENTIAL, { tabId, key }),
    clearCredential: (tabId: string) =>
      ipcRenderer.invoke(IPC.AGENT_CLEAR_CREDENTIAL, { tabId }),
    checkAuth: (tabId: string) =>
      ipcRenderer.invoke(IPC.AGENT_CHECK_AUTH, { tabId }),
    startLogin: (tabId: string) =>
      ipcRenderer.invoke(IPC.AGENT_START_LOGIN, { tabId }),
    cancelLogin: (tabId: string) =>
      ipcRenderer.invoke(IPC.AGENT_CANCEL_LOGIN, { tabId }),
    fetchTaskOutput: (tabId: string, taskId: string) =>
      ipcRenderer.invoke(IPC.AGENT_READ_TASK_OUTPUT, { tabId, taskId }),
    stopTask: (tabId: string, taskId: string) =>
      ipcRenderer.invoke(IPC.AGENT_STOP_TASK, { tabId, taskId }),
    onMessage: (callback: (tabId: string, msg: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, msg: unknown) => callback(tabId, msg);
      ipcRenderer.on(IPC.AGENT_MESSAGE, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_MESSAGE, listener);
    },
    onStream: (callback: (tabId: string, chunk: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, chunk: unknown) => callback(tabId, chunk);
      ipcRenderer.on(IPC.AGENT_STREAM, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_STREAM, listener);
    },
    onStatus: (callback: (tabId: string, status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, status: unknown) => callback(tabId, status);
      ipcRenderer.on(IPC.AGENT_STATUS, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_STATUS, listener);
    },
    onPlan: (callback: (tabId: string, payload: { content: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, payload: { content: string }) => callback(tabId, payload);
      ipcRenderer.on(IPC.AGENT_PLAN, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_PLAN, listener);
    },
    onBackgroundTasks: (callback: (tabId: string, event: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, event: unknown) => callback(tabId, event);
      ipcRenderer.on(IPC.AGENT_BACKGROUND_TASKS, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_BACKGROUND_TASKS, listener);
    },
    onQueue: (callback: (tabId: string, items: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, items: unknown) => callback(tabId, items);
      ipcRenderer.on(IPC.AGENT_QUEUE, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_QUEUE, listener);
    },
    onConnectionHealth: (callback: (tabId: string, health: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, health: unknown) => callback(tabId, health);
      ipcRenderer.on(IPC.AGENT_CONNECTION_HEALTH, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_CONNECTION_HEALTH, listener);
    },
    onPermissionRequest: (callback: (tabId: string, req: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, req: unknown) => callback(tabId, req);
      ipcRenderer.on(IPC.AGENT_PERMISSION_REQUEST, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_PERMISSION_REQUEST, listener);
    },
    onPickerRequest: (callback: (tabId: string, req: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, req: unknown) => callback(tabId, req);
      ipcRenderer.on(IPC.AGENT_PICKER_REQUEST, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_PICKER_REQUEST, listener);
    },
    onCapabilities: (callback: (tabId: string, caps: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, caps: unknown) => callback(tabId, caps);
      ipcRenderer.on(IPC.AGENT_CAPABILITIES, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_CAPABILITIES, listener);
    },
    onAuthRequired: (callback: (tabId: string, provider: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, provider: string) => callback(tabId, provider);
      ipcRenderer.on(IPC.AGENT_AUTH_REQUIRED, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_AUTH_REQUIRED, listener);
    },
    onInitStatus: (callback: (tabId: string, status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, status: unknown) => callback(tabId, status);
      ipcRenderer.on(IPC.AGENT_INIT_STATUS, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_INIT_STATUS, listener);
    },
    onLoginPrompt: (callback: (tabId: string, prompt: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, prompt: unknown) => callback(tabId, prompt);
      ipcRenderer.on(IPC.AGENT_LOGIN_PROMPT, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_LOGIN_PROMPT, listener);
    },
    onLoginDone: (callback: (tabId: string, result: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, tabId: string, result: unknown) => callback(tabId, result);
      ipcRenderer.on(IPC.AGENT_LOGIN_DONE, listener);
      return () => ipcRenderer.removeListener(IPC.AGENT_LOGIN_DONE, listener);
    },
  },
  updater: {
    check: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
    download: () => ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),
    install: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL),
    onStatus: (callback: (status: import('../shared/types').UpdateStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: import('../shared/types').UpdateStatus) => {
        callback(status);
      };
      ipcRenderer.on(IPC.UPDATE_STATUS, listener);
      return () => ipcRenderer.removeListener(IPC.UPDATE_STATUS, listener);
    },
  },
});
