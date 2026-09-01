import type { AppOS } from './app-os';
import type { ConnectorConfig } from './config';
import type { ConnectorRuntime } from './runtime';

/**
 * Stable target identity for one live connector runtime. Runtime-only SSH
 * settings do not describe a different transport endpoint.
 */
export function connectorRuntimeKey(config: ConnectorConfig): string {
  switch (config.type) {
    case 'local':
      return 'local';
    case 'ssh':
      return JSON.stringify(['ssh', config.host, config.port, config.user]);
    case 'wsl':
      return JSON.stringify(['wsl', config.distro]);
    case 'docker':
      return JSON.stringify(['docker', config.container]);
  }
}

/** Main-owned runtime generations; TerminalView instances never own this map. */
export class ConnectorRuntimeOwner {
  private readonly runtimes = new Map<string, ConnectorRuntime>();

  constructor(private readonly appOS: AppOS) {}

  get(config: ConnectorConfig): ConnectorRuntime {
    const key = connectorRuntimeKey(config);
    const existing = this.runtimes.get(key);
    if (existing) return existing;

    const runtime = this.appOS.createRuntime(config);
    this.runtimes.set(key, runtime);
    return runtime;
  }

  invalidate(config: ConnectorConfig): void {
    const key = connectorRuntimeKey(config);
    this.runtimes.get(key)?.invalidate();
    this.runtimes.delete(key);
  }

  invalidateAll(): void {
    for (const runtime of this.runtimes.values()) runtime.invalidate();
    this.runtimes.clear();
  }
}
