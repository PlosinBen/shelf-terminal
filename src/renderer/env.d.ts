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
