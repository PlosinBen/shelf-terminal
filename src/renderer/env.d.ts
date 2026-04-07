interface ShelfApi {
  pty: {
    spawn: (projectId: string, tabId: string, cwd: string) => Promise<void>;
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
  project: {
    load: () => Promise<import('../shared/types').ProjectConfig[]>;
    save: (projects: import('../shared/types').ProjectConfig[]) => Promise<void>;
  };
  clipboard: {
    saveImage: (buffer: ArrayBuffer) => Promise<string>;
  };
}

interface Window {
  shelfApi: ShelfApi;
}
