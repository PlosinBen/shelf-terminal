declare const __APP_VERSION__: string;

interface ShelfApi {
  pty: {
    spawn: (projectId: string, tabId: string, cwd: string, connection: import('../shared/types').Connection, initScript?: string, tabCmd?: string) => Promise<void>;
    input: (tabId: string, data: string) => void;
    resize: (tabId: string, cols: number, rows: number) => void;
    kill: (tabId: string) => Promise<void>;
    mute: (tabId: string, muted: boolean) => void;
    onData: (callback: (tabId: string, data: string) => void) => () => void;
    onExit: (callback: (tabId: string, exitCode: number) => void) => () => void;
    onInitSent: (callback: (tabId: string) => void) => () => void;
  };
  connector: {
    listDir: (connection: import('../shared/types').Connection, dirPath: string) => Promise<import('../shared/types').FolderListResult>;
    homePath: (connection: import('../shared/types').Connection) => Promise<string>;
    isConnected: (connection: import('../shared/types').Connection) => Promise<boolean>;
    connect: (connection: import('../shared/types').Connection, password?: string) => Promise<void>;
    availableTypes: () => Promise<import('../shared/types').Connection['type'][]>;
    uploadFile: (
      connection: import('../shared/types').Connection,
      cwd: string,
      filename: string,
      buffer: ArrayBuffer,
    ) => Promise<import('../shared/types').FileUploadResult>;
    clearUploads: (
      connection: import('../shared/types').Connection,
      cwd: string,
    ) => Promise<import('../shared/types').FileClearResult>;
    getUploadsSize: (
      connection: import('../shared/types').Connection,
      cwd: string,
    ) => Promise<{ totalBytes: number; fileCount: number }>;
  };
  project: {
    load: () => Promise<import('../shared/types').ProjectConfig[]>;
    save: (projects: import('../shared/types').ProjectConfig[]) => Promise<void>;
    validateDirs: (projects: import('../shared/types').ProjectConfig[]) => Promise<string[]>;
  };
  dialog: {
    warn: (title: string, message: string) => Promise<void>;
    confirm: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  };
  docker: {
    listContainers: () => Promise<string[]>;
  };
  wsl: {
    listDistros: () => Promise<string[]>;
  };
  ssh: {
    removeHostKey: (host: string, port: number) => Promise<void>;
    servers: () => Promise<Array<{ host: string; port: number; user: string }>>;
  };
  git: {
    branchList: (connection: import('../shared/types').Connection, cwd: string) => Promise<import('../shared/types').GitBranchInfo[]>;
    checkDirty: (connection: import('../shared/types').Connection, cwd: string) => Promise<boolean>;
    checkout: (connection: import('../shared/types').Connection, cwd: string, branch: string) => Promise<{ ok: boolean; error?: string }>;
    worktreeAdd: (connection: import('../shared/types').Connection, cwd: string, branch: string, newBranch: boolean) => Promise<import('../shared/types').WorktreeAddResult>;
    worktreeRemove: (connection: import('../shared/types').Connection, cwd: string, worktreePath: string) => Promise<import('../shared/types').WorktreeRemoveResult>;
  };
  settings: {
    load: () => Promise<import('../shared/types').AppSettings>;
    save: (settings: import('../shared/types').AppSettings) => Promise<void>;
  };
  logs: {
    clear: () => Promise<void>;
    size: () => Promise<{ totalBytes: number; fileCount: number }>;
  };
  notes: {
    list: (projectId: string) => Promise<Array<{ id: string; title: string; isDone: boolean; created: string; updated: string }>>;
    get: (projectId: string, noteId: string) => Promise<{ id: string; title: string; isDone: boolean; created: string; updated: string; body: string; images: string[] } | null>;
    create: (projectId: string) => Promise<{ id: string; title: string; isDone: boolean; created: string; updated: string }>;
    quickCreate: (projectId: string, body: string, images?: string[]) => Promise<{ id: string; title: string; isDone: boolean; created: string; updated: string } | null>;
    update: (
      projectId: string,
      noteId: string,
      patch: { title?: string; isDone?: boolean; body?: string; images?: string[] },
    ) => Promise<{ id: string; title: string; isDone: boolean; created: string; updated: string } | null>;
    delete: (projectId: string, noteId: string) => Promise<void>;
    deleteAllDone: (projectId: string) => Promise<number>;
    saveImage: (projectId: string, buffer: ArrayBuffer, ext: string) => Promise<string>;
    readImage: (projectId: string, filename: string) => Promise<ArrayBuffer | null>;
  };
  skills: {
    list: () => Promise<Array<{ name: string; description?: string }>>;
    get: (name: string) => Promise<string | null>;
    create: () => Promise<{ name: string; description?: string }>;
    update: (name: string, content: string) => Promise<{ ok: boolean; name?: string; error?: string }>;
    delete: (name: string) => Promise<void>;
    /** Subscribe to "skills changed" (any trigger). Returns an unsubscribe fn. */
    onChanged: (callback: () => void) => () => void;
  };
  app: {
    logsPath: () => Promise<string>;
  };
  pm: {
    send: (message: string) => Promise<void>;
    stop: () => Promise<void>;
    history: () => Promise<import('../shared/types').PmMessage[]>;
    clear: () => Promise<void>;
    compact: () => Promise<{ kept: number; removed: number }>;
    syncState: (state: any) => void;
    setAwayMode: (on: boolean) => Promise<void>;
    getAwayMode: () => Promise<boolean>;
    listModels: (baseURL: string) => Promise<import('../shared/types').PmListModelsResult>;
    onAwayMode: (callback: (on: boolean) => void) => () => void;
    setActive: (on: boolean) => Promise<void>;
    getActive: () => Promise<boolean>;
    onActive: (callback: (on: boolean) => void) => () => void;
    onActiveError: (callback: (reason: string) => void) => () => void;
    onStream: (callback: (chunk: import('../shared/types').PmStreamChunk) => void) => () => void;
  };
  agent: {
    init: (tabId: string, cwd: string, connection: import('../shared/types').Connection, provider: string, sessionId?: string, opts?: Record<string, unknown>) => Promise<boolean>;
    send: (tabId: string, prompt: string, images?: string[], prefs?: { model?: string; effort?: string; permissionMode?: string; configEdit?: { key: 'model' | 'effort' | 'permissionMode'; value: string } }) => Promise<boolean>;
    stop: (tabId: string) => Promise<boolean>;
    destroy: (tabId: string) => Promise<void>;
    resolvePermission: (tabId: string, toolUseId: string, allow: boolean, scope?: 'once' | 'session') => Promise<boolean>;
    resolvePicker: (
      tabId: string,
      pickerId: string,
      payload: { answers: Array<string | string[]> } | { cancelled: true },
    ) => Promise<boolean>;
    storeCredential: (tabId: string, key: string) => Promise<boolean>;
    clearCredential: (tabId: string) => Promise<boolean>;
    checkAuth: (tabId: string) => Promise<boolean>;
    fetchTaskOutput: (tabId: string, taskId: string) => Promise<string>;
    stopTask: (tabId: string, taskId: string) => Promise<void>;
    onMessage: (callback: (tabId: string, msg: unknown) => void) => () => void;
    onStream: (callback: (tabId: string, chunk: unknown) => void) => () => void;
    onStatus: (callback: (tabId: string, status: unknown) => void) => () => void;
    onPlan: (callback: (tabId: string, payload: { content: string }) => void) => () => void;
    onBackgroundTasks: (callback: (tabId: string, event: import('../shared/types').TaskEvent) => void) => () => void;
    onConnectionHealth: (callback: (tabId: string, health: import('../shared/types').ConnectionHealth) => void) => () => void;
    onPermissionRequest: (callback: (tabId: string, req: unknown) => void) => () => void;
    onPickerRequest: (callback: (tabId: string, req: unknown) => void) => () => void;
    onCapabilities: (callback: (tabId: string, caps: unknown) => void) => () => void;
    onAuthRequired: (callback: (tabId: string, provider: string) => void) => () => void;
    onInitStatus: (callback: (tabId: string, status: import('../shared/types').AgentInitStatus) => void) => () => void;
  };
  updater: {
    check: () => Promise<void>;
    download: () => Promise<void>;
    install: () => Promise<void>;
    onStatus: (callback: (status: import('../shared/types').UpdateStatus) => void) => () => void;
  };
}

interface Window {
  shelfApi: ShelfApi;
}
