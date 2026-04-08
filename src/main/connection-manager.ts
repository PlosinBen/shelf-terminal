import type { Connection } from '../shared/types';
import { checkConnection, cleanupControlSockets } from './ssh-control';
import { sshEstablishConnection } from './ssh-manager';
import { log } from '../shared/logger';

export function isConnected(connection: Connection): boolean {
  switch (connection.type) {
    case 'ssh':
      return checkConnection(connection.host, connection.port, connection.user);
    case 'wsl':
    case 'local':
    default:
      return true;
  }
}

export async function connect(connection: Connection, password?: string): Promise<void> {
  switch (connection.type) {
    case 'ssh':
      if (isConnected(connection)) {
        log.debug('connection', `already connected: ${connection.user}@${connection.host}:${connection.port}`);
        return;
      }
      if (!password) {
        throw new Error('SSH password required for first connection');
      }
      await sshEstablishConnection(connection.host, connection.port, connection.user, password);
      break;
    case 'wsl':
    case 'local':
    default:
      break;
  }
}

export function cleanup(): void {
  cleanupControlSockets();
}
