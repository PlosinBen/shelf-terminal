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
  };
  folder: {
    list: (dirPath: string) => Promise<import('../shared/types').FolderListResult>;
    homePath: () => Promise<string>;
  };
  connector: {
    listDir: (connection: import('../shared/types').Connection, dirPath: string) => Promise<import('../shared/types').FolderListResult>;
    homePath: (connection: import('../shared/types').Connection) => Promise<string>;
    isConnected: (connection: import('../shared/types').Connection) => Promise<boolean>;
    connect: (connection: import('../shared/types').Connection, password?: string) => Promise<void>;
    uploadFile: (
      connection: import('../shared/types').Connection,
      cwd: string,
      filename: string,
      buffer: ArrayBuffer,
    ) => Promise<import('../shared/types').FileUploadResult>;
  };
  project: {
    load: () => Promise<import('../shared/types').ProjectConfig[]>;
    save: (projects: import('../shared/types').ProjectConfig[]) => Promise<void>;
  };
  dialog: {
    warn: (title: string, message: string) => Promise<void>;
  };
  docker: {
    listContainers: () => Promise<string[]>;
  };
  wsl: {
    listDir: (distro: string, dirPath: string) => Promise<import('../shared/types').FolderListResult>;
    homePath: (distro: string) => Promise<string>;
    listDistros: () => Promise<string[]>;
  };
  ssh: {
    listDir: (host: string, port: number, user: string, dirPath: string) => Promise<import('../shared/types').FolderListResult>;
    homePath: (host: string, port: number, user: string) => Promise<string>;
    removeHostKey: (host: string, port: number) => Promise<void>;
  };
  settings: {
    load: () => Promise<import('../shared/types').AppSettings>;
    save: (settings: import('../shared/types').AppSettings) => Promise<void>;
  };
  logs: {
    clear: () => Promise<void>;
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
