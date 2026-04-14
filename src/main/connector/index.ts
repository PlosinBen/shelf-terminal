import type { Connection } from '../../shared/types';
import type { Connector } from './types';
import { LocalUnixConnector } from './local/unix';
import { LocalWin32Connector } from './local/win32';
import { SSHUnixConnector } from './ssh/unix';
import { SSHWin32Connector } from './ssh/win32';
import { WSLConnector, listWSLDistros as _listWSLDistros } from './wsl';
import { DockerConnector, listDockerContainers as _listDockerContainers, setDockerPath as _setDockerPath, testDockerPath as _testDockerPath } from './docker';
import { cleanupControlSockets } from '../ssh-control';

// Re-export types for consumers
export type { Connector, Shell, Disposable } from './types';

export function createConnector(connection: Connection): Connector {
  switch (connection.type) {
    case 'local':
      return process.platform === 'win32'
        ? new LocalWin32Connector()
        : new LocalUnixConnector();
    case 'ssh':
      return process.platform === 'win32'
        ? new SSHWin32Connector(connection.host, connection.port, connection.user)
        : new SSHUnixConnector(connection.host, connection.port, connection.user);
    case 'wsl':
      if (process.platform !== 'win32') {
        throw new Error('WSL is only available on Windows');
      }
      return new WSLConnector(connection.distro);
    case 'docker':
      return new DockerConnector(connection.container);
  }
}

export type ConnectionType = Connection['type'];

export function getAvailableTypes(): ConnectionType[] {
  if (process.platform === 'win32') {
    return ['local', 'ssh', 'wsl', 'docker'];
  }
  return ['local', 'ssh', 'docker'];
}

export function listDockerContainers(): Promise<string[]> {
  return _listDockerContainers();
}

export function setDockerPath(p: string | undefined): void {
  _setDockerPath(p);
}

export function testDockerPath(p: string): Promise<{ ok: boolean; version?: string; error?: string }> {
  return _testDockerPath(p);
}

export function listWSLDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return _listWSLDistros();
}

/** Call on app quit to terminate SSH ControlMaster processes. */
export function cleanupConnectors(): void {
  cleanupControlSockets();
}
