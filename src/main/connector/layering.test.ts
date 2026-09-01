import { describe, expect, it } from 'vitest';
import type { Connector, ExecResult, Shell } from './types';
import { createAppOS } from './app-os';
import { toConnectorConfig } from './config';
import { ConnectorRuntimeOwner } from './runtime-owner';

function stubConnector(): Connector {
  return {
    createShell: () => ({
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write() {},
      resize() {},
      kill() {},
    } satisfies Shell),
    isConnected: () => Promise.resolve(true),
    connect: () => Promise.resolve(),
    exec: () => Promise.resolve({ stdout: '', stderr: '' } satisfies ExecResult),
    listDir: (path) => Promise.resolve({ path, entries: [] }),
    homePath: () => Promise.resolve('/home/test'),
    uploadFile: (_cwd, filename) => Promise.resolve(filename),
    putFile: () => Promise.resolve(),
    cleanupSession: () => Promise.resolve(0),
    clearUploads: () => Promise.resolve(0),
    getUploadsSize: () => Promise.resolve({ totalBytes: 0, fileCount: 0 }),
  };
}

describe('connector layering contracts', () => {
  it('copies persisted connection data into an immutable ConnectorConfig', () => {
    const connection = { type: 'ssh' as const, host: 'dev.example', port: 2222, user: 'ben' };

    const config = toConnectorConfig(connection);

    expect(config).toEqual(connection);
    expect(config).not.toBe(connection);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('derives POSIX structural support from registered adapters', () => {
    const appOS = createAppOS('darwin', {
      local: () => stubConnector(),
      ssh: () => stubConnector(),
      docker: () => stubConnector(),
    });

    expect(appOS.supportedConnectorTypes()).toEqual(['local', 'ssh', 'docker']);
    expect(appOS.supports('wsl')).toBe(false);
  });

  it('derives Windows structural support from registered adapters', () => {
    const appOS = createAppOS('win32', {
      local: () => stubConnector(),
      ssh: () => stubConnector(),
      wsl: () => stubConnector(),
      docker: () => stubConnector(),
    });

    expect(appOS.supportedConnectorTypes()).toEqual(['local', 'ssh', 'wsl', 'docker']);
  });

  it('fails explicitly when the configured connector has no app-OS adapter', () => {
    const appOS = createAppOS('linux', {
      local: () => stubConnector(),
      ssh: () => stubConnector(),
      docker: () => stubConnector(),
    });

    expect(() => appOS.createRuntime(toConnectorConfig({ type: 'wsl', distro: 'Ubuntu' })))
      .toThrow('Connector "wsl" is not supported on linux');
  });

  it('assigns a distinct immutable generation to each runtime', () => {
    const appOS = createAppOS('linux', { local: () => stubConnector() });
    const config = toConnectorConfig({ type: 'local' });

    const first = appOS.createRuntime(config);
    const second = appOS.createRuntime(config);

    expect(first.generation).not.toBe(second.generation);
    expect(first.generation.id).not.toBe(second.generation.id);
    expect(Object.isFrozen(first.generation)).toBe(true);
  });

  it('reuses one runtime generation for the same live connector identity', () => {
    const owner = new ConnectorRuntimeOwner(createAppOS('linux', { ssh: () => stubConnector() }));
    const firstConfig = toConnectorConfig({
      type: 'ssh', host: 'dev.example', port: 22, user: 'ben', idleShutdownMinutes: 5,
    });
    const sameTarget = toConnectorConfig({
      type: 'ssh', host: 'dev.example', port: 22, user: 'ben', idleShutdownMinutes: 0,
    });

    expect(owner.get(firstConfig)).toBe(owner.get(sameTarget));
  });

  it('replaces the runtime generation after explicit invalidation', () => {
    const owner = new ConnectorRuntimeOwner(createAppOS('linux', { local: () => stubConnector() }));
    const config = toConnectorConfig({ type: 'local' });
    const first = owner.get(config);

    owner.invalidate(config);

    expect(owner.get(config).generation.id).not.toBe(first.generation.id);
  });
});
