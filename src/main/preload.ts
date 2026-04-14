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
  },
  project: {
    load: () => ipcRenderer.invoke(IPC.PROJECT_LOAD),
    save: (projects: unknown) => ipcRenderer.invoke(IPC.PROJECT_SAVE, projects),
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
    testPath: (dockerPath: string) =>
      ipcRenderer.invoke(IPC.DOCKER_TEST_PATH, dockerPath),
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
  settings: {
    load: () => ipcRenderer.invoke(IPC.SETTINGS_LOAD),
    save: (settings: unknown) => ipcRenderer.invoke(IPC.SETTINGS_SAVE, settings),
  },
  logs: {
    clear: () => ipcRenderer.invoke(IPC.LOGS_CLEAR),
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
