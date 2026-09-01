import type { Connection } from '@shared/types';
import type { Connector } from './types';
import { listWSLDistros as _listWSLDistros } from './wsl';
import { listDockerContainers as _listDockerContainers } from './docker';
import { cleanupControlSockets } from '../ssh-control';
import { createAppOS } from './app-os';
import { toConnectorConfig } from './config';
import { ConnectorRuntimeOwner } from './runtime-owner';

// Re-export types for consumers
export type { Connector, Shell, Disposable, ExecResult } from './types';
export type { ConnectorConfig, ConnectorType } from './config';
export type { RuntimeGeneration } from './runtime';
export type { TerminalLaunchPlan, TerminalLaunchKind } from './launch-plan';

const appOS = createAppOS();
const runtimeOwner = new ConnectorRuntimeOwner(appOS);

export function createConnector(connection: Connection): Connector {
  return runtimeOwner.get(toConnectorConfig(connection));
}

export function invalidateConnectorRuntime(connection: Connection): void {
  runtimeOwner.invalidate(toConnectorConfig(connection));
}

export type ConnectionType = Connection['type'];

export function getAvailableTypes(): ConnectionType[] {
  return appOS.supportedConnectorTypes();
}

export function listDockerContainers(): Promise<string[]> {
  return _listDockerContainers();
}

export function listWSLDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return _listWSLDistros();
}

/** Call on app quit to terminate SSH ControlMaster processes. */
export function cleanupConnectors(): void {
  runtimeOwner.invalidateAll();
  cleanupControlSockets();
}
