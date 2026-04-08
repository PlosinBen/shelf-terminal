interface ShelfApi {
  pty: {
    spawn: (projectId: string, tabId: string, cwd: string, connection: import('../shared/types').Connection, initScript?: string) => Promise<void>;
    input: (tabId: string, data: string) => void;
    resize: (tabId: string, cols: number, rows: number) => void;
    kill: (tabId: string) => Promise<void>;
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
  };
  project: {
    load: () => Promise<import('../shared/types').ProjectConfig[]>;
    save: (projects: import('../shared/types').ProjectConfig[]) => Promise<void>;
  };
  clipboard: {
    saveImage: (buffer: ArrayBuffer) => Promise<string>;
    saveImageRemote: (buffer: ArrayBuffer, host: string, port: number, user: string) => Promise<string>;
  };
  wsl: {
    listDir: (distro: string, dirPath: string) => Promise<import('../shared/types').FolderListResult>;
    homePath: (distro: string) => Promise<string>;
    listDistros: () => Promise<string[]>;
  };
  ssh: {
    listDir: (host: string, port: number, user: string, dirPath: string) => Promise<import('../shared/types').FolderListResult>;
    homePath: (host: string, port: number, user: string) => Promise<string>;
  };
  settings: {
    load: () => Promise<import('../shared/types').AppSettings>;
    save: (settings: import('../shared/types').AppSettings) => Promise<void>;
  };
  logs: {
    clear: () => Promise<void>;
  };
}

interface Window {
  shelfApi: ShelfApi;
}
