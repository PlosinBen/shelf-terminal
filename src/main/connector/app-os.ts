import type { Connector } from './types';
import type { ConnectorConfig, ConnectorType } from './config';
import { ConnectorRuntime } from './runtime';
import { LocalUnixConnector } from './local/unix';
import { LocalWin32Connector } from './local/win32';
import { SSHUnixConnector } from './ssh/unix';
import { SSHWin32Connector } from './ssh/win32';
import { WSLConnector } from './wsl';
import { DockerConnector } from './docker';

export type ConnectorAdapterFactory = (config: ConnectorConfig) => Connector;
export type ConnectorAdapterRegistry = Partial<Record<ConnectorType, ConnectorAdapterFactory>>;

const CONNECTOR_ORDER: readonly ConnectorType[] = ['local', 'ssh', 'wsl', 'docker'];

function posixRegistry(): ConnectorAdapterRegistry {
  return {
    local: () => new LocalUnixConnector(),
    ssh: (config) => {
      if (config.type !== 'ssh') throw configMismatch('ssh', config.type);
      return new SSHUnixConnector(config.host, config.port, config.user);
    },
    docker: (config) => {
      if (config.type !== 'docker') throw configMismatch('docker', config.type);
      return new DockerConnector(config.container);
    },
  };
}

function windowsRegistry(): ConnectorAdapterRegistry {
  return {
    local: () => new LocalWin32Connector(),
    ssh: (config) => {
      if (config.type !== 'ssh') throw configMismatch('ssh', config.type);
      return new SSHWin32Connector(config.host, config.port, config.user);
    },
    wsl: (config) => {
      if (config.type !== 'wsl') throw configMismatch('wsl', config.type);
      return new WSLConnector(config.distro);
    },
    docker: (config) => {
      if (config.type !== 'docker') throw configMismatch('docker', config.type);
      return new DockerConnector(config.container);
    },
  };
}

function configMismatch(expected: ConnectorType, actual: ConnectorType): Error {
  return new Error(`Connector adapter "${expected}" received "${actual}" config`);
}

export interface AppOS {
  readonly platform: NodeJS.Platform;
  supports(type: ConnectorType): boolean;
  supportedConnectorTypes(): ConnectorType[];
  createRuntime(config: ConnectorConfig): ConnectorRuntime;
}

/** App-runtime OS boundary and the single structural connector support registry. */
export function createAppOS(
  platform: NodeJS.Platform = process.platform,
  registry: ConnectorAdapterRegistry = platform === 'win32' ? windowsRegistry() : posixRegistry(),
): AppOS {
  const adapters = Object.freeze({ ...registry });

  return Object.freeze({
    platform,
    supports(type: ConnectorType): boolean {
      return adapters[type] !== undefined;
    },
    supportedConnectorTypes(): ConnectorType[] {
      return CONNECTOR_ORDER.filter((type) => adapters[type] !== undefined);
    },
    createRuntime(config: ConnectorConfig): ConnectorRuntime {
      const create = adapters[config.type];
      if (!create) {
        throw new Error(`Connector "${config.type}" is not supported on ${platform}`);
      }
      return new ConnectorRuntime(config, create(config));
    },
  });
}
