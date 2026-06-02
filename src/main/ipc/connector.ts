import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { createConnector, getAvailableTypes, listDockerContainers, listWSLDistros } from '../connector';
import { removeHostKey } from '../ssh-control';
import { loadSSHServers, saveSSHServer } from '../ssh-server-store';
import type { Connection } from '@shared/types';

export function registerConnectorHandlers(): void {
  // ── Connector (unified) ──

  ipcMain.handle(IPC.CONNECTOR_LIST_DIR, (_event, payload: { connection: Connection; path: string }) => {
    const connector = createConnector(payload.connection);
    return connector.listDir(payload.path);
  });

  ipcMain.handle(IPC.CONNECTOR_HOME_PATH, (_event, connection: Connection) => {
    const connector = createConnector(connection);
    return connector.homePath();
  });

  ipcMain.handle(IPC.CONNECTOR_CHECK, (_event, connection: Connection) => {
    const connector = createConnector(connection);
    return connector.isConnected();
  });

  ipcMain.handle(IPC.CONNECTOR_ESTABLISH, async (_event, payload: { connection: Connection; password?: string }) => {
    const connector = createConnector(payload.connection);
    await connector.connect(payload.password);
    // Auto-save SSH server on successful connect
    if (payload.connection.type === 'ssh') {
      saveSSHServer({
        host: payload.connection.host,
        port: payload.connection.port,
        user: payload.connection.user,
      });
    }
  });

  ipcMain.handle(IPC.CONNECTOR_AVAILABLE_TYPES, () => {
    return getAvailableTypes();
  });

  // ── Connector — type-specific ──

  ipcMain.handle(IPC.SSH_REMOVE_HOST_KEY, (_event, payload: { host: string; port: number }) => {
    removeHostKey(payload.host, payload.port);
  });

  ipcMain.handle(IPC.SSH_SERVERS, () => {
    return loadSSHServers();
  });

  ipcMain.handle(IPC.WSL_LIST_DISTROS, () => {
    return listWSLDistros();
  });

  ipcMain.handle(IPC.DOCKER_LIST_CONTAINERS, () => {
    return listDockerContainers();
  });
}
