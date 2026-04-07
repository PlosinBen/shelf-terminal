import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

contextBridge.exposeInMainWorld('shelfApi', {
  pty: {
    spawn: (projectId: string, tabId: string, cwd: string, connection: unknown) =>
      ipcRenderer.invoke(IPC.PTY_SPAWN, { projectId, tabId, cwd, connection }),
    input: (tabId: string, data: string) =>
      ipcRenderer.send(IPC.PTY_INPUT, { tabId, data }),
    resize: (tabId: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC.PTY_RESIZE, { tabId, cols, rows }),
    kill: (tabId: string) =>
      ipcRenderer.invoke(IPC.PTY_KILL, { tabId }),
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
  folder: {
    list: (dirPath: string) =>
      ipcRenderer.invoke(IPC.FOLDER_LIST, { path: dirPath }),
    homePath: () =>
      ipcRenderer.invoke(IPC.HOME_PATH),
  },
  project: {
    load: () => ipcRenderer.invoke(IPC.PROJECT_LOAD),
    save: (projects: unknown) => ipcRenderer.invoke(IPC.PROJECT_SAVE, projects),
  },
  clipboard: {
    saveImage: (buffer: ArrayBuffer) =>
      ipcRenderer.invoke(IPC.CLIPBOARD_SAVE_IMAGE, buffer),
    saveImageRemote: (buffer: ArrayBuffer, host: string, port: number, user: string) =>
      ipcRenderer.invoke(IPC.CLIPBOARD_SAVE_IMAGE_REMOTE, { buffer, host, port, user }),
  },
  ssh: {
    listDir: (host: string, port: number, user: string, dirPath: string) =>
      ipcRenderer.invoke(IPC.SSH_LIST_DIR, { host, port, user, path: dirPath }),
  },
  settings: {
    load: () => ipcRenderer.invoke(IPC.SETTINGS_LOAD),
    save: (settings: unknown) => ipcRenderer.invoke(IPC.SETTINGS_SAVE, settings),
  },
});
