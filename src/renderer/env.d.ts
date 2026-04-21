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
    testPath: (dockerPath: string) => Promise<{ ok: boolean; version?: string; error?: string }>;
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
  };
  app: {
    logsPath: () => Promise<string>;
  };
  agent: {
    init: (tabId: string, provider: string, connection: import('../shared/types').Connection, cwd: string, initScript?: string, prefs?: import('../shared/types').AgentPrefs, sessionIds?: Partial<Record<import('../shared/types').AgentProvider, string>>) => Promise<void>;
    send: (tabId: string, prompt: string, cwd: string, provider: string, connection: import('../shared/types').Connection, initScript?: string, attachments?: { files?: string[]; images?: string[] }) => Promise<void>;
    stop: (tabId: string) => Promise<void>;
    destroy: (tabId: string) => Promise<void>;
    deleteHistories: (sessionIds: string[]) => Promise<void>;
    resolvePermission: (tabId: string, toolUseId: string, scope: 'once' | 'session' | 'deny', toolName?: string, input?: Record<string, unknown>) => Promise<void>;
    setPrefs: (tabId: string, prefs: import('../shared/types').AgentPrefs) => Promise<void>;
    storeCredential: (tabId: string, key: string) => Promise<{ ok: boolean; error?: string }>;
    clearCredential: (tabId: string) => Promise<{ ok: boolean; error?: string }>;
    checkAuth: (tabId: string) => Promise<{ authenticated: boolean }>;
    switchProvider: (tabId: string, provider: string, connection: import('../shared/types').Connection, initScript?: string) => Promise<void>;
    onCapabilities: (callback: (payload: { tabId: string; models: { value: string; displayName: string; effortLevels?: string[]; vision?: boolean }[]; permissionModes: string[]; effortLevels: string[]; slashCommands: { name: string; description: string }[]; currentModel?: string; currentEffort?: string; currentPermissionMode?: string; authMethod?: import('../shared/types').AuthMethod }) => void) => () => void;
    onMessage: (callback: (payload: { tabId: string; type: string; content: string; toolName?: string; toolInput?: Record<string, unknown>; toolUseId?: string; parentToolUseId?: string; sessionId?: string; costUsd?: number; inputTokens?: number; outputTokens?: number }) => void) => () => void;
    onStream: (callback: (payload: { tabId: string; type: string; content: string }) => void) => () => void;
    onStatus: (callback: (payload: { tabId: string; state: string; model?: string; costUsd?: number; inputTokens?: number; outputTokens?: number; numTurns?: number; sessionId?: string }) => void) => () => void;
    onPermissionRequest: (callback: (payload: { tabId: string; toolUseId: string; toolName: string; input: Record<string, unknown> }) => void) => () => void;
    onAuthRequired: (callback: (payload: { tabId: string; provider: string }) => void) => () => void;
  };
  copilotAuth: {
    recheck: () => Promise<{ authenticated: boolean }>;
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
