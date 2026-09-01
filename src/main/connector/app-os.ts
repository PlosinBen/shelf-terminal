import * as pty from 'node-pty';
import fs from 'fs';
import os from 'os';
import type { Connector, Shell } from './types';
import type { ConnectorConfig, ConnectorType } from './config';
import { ConnectorRuntime, type TerminalPlanAdapter } from './runtime';
import {
  TERMINAL_LAUNCH_KIND,
  freezeTerminalLaunchPlan,
  type TerminalLaunchPlan,
  type TerminalLaunchRequest,
} from './launch-plan';
import { LocalUnixConnector } from './local/unix';
import { LocalWin32Connector } from './local/win32';
import { SSHUnixConnector } from './ssh/unix';
import { SSHWin32Connector } from './ssh/win32';
import { WSLConnector } from './wsl';
import { DockerConnector } from './docker';
import { wrapPty } from './wrap-pty';
import { getShellEnv, resolveShell, shellEscape } from './shell-env';
import { applyEnvMap, buildEnvExportPrefix } from '@shared/project-env';
import { shellSingleQuote } from './file-utils';
import { getControlPath, getKnownHostsPath } from '../ssh-control';
import { log } from '@shared/logger';

export type ConnectorAdapterFactory = (config: ConnectorConfig) => Connector;

export interface ConnectorAppOSAdapter {
  createConnector(config: ConnectorConfig): Connector;
  materialize(config: ConnectorConfig, request: TerminalLaunchRequest): TerminalLaunchPlan;
}

export type ConnectorAdapterRegistration = ConnectorAppOSAdapter | ConnectorAdapterFactory;
export type ConnectorAdapterRegistry = Partial<Record<ConnectorType, ConnectorAdapterRegistration>>;

const CONNECTOR_ORDER: readonly ConnectorType[] = ['local', 'ssh', 'wsl', 'docker'];

function posixRegistry(): ConnectorAdapterRegistry {
  return {
    local: {
      createConnector: () => new LocalUnixConnector(),
      materialize: (_config, request) => materializeLocalUnix(request),
    },
    ssh: {
      createConnector: (config) => {
        const ssh = requireConfig(config, 'ssh');
        return new SSHUnixConnector(ssh.host, ssh.port, ssh.user);
      },
      materialize: (config, request) => materializeSSH(requireConfig(config, 'ssh'), request, true),
    },
    docker: {
      createConnector: (config) => new DockerConnector(requireConfig(config, 'docker').container),
      materialize: (config, request) => materializeDocker(requireConfig(config, 'docker'), request),
    },
  };
}

function windowsRegistry(): ConnectorAdapterRegistry {
  return {
    local: {
      createConnector: () => new LocalWin32Connector(),
      materialize: (_config, request) => materializeLocalWindows(request),
    },
    ssh: {
      createConnector: (config) => {
        const ssh = requireConfig(config, 'ssh');
        return new SSHWin32Connector(ssh.host, ssh.port, ssh.user);
      },
      materialize: (config, request) => materializeSSH(requireConfig(config, 'ssh'), request, false),
    },
    wsl: {
      createConnector: (config) => new WSLConnector(requireConfig(config, 'wsl').distro),
      materialize: (config, request) => materializeWSL(requireConfig(config, 'wsl'), request),
    },
    docker: {
      createConnector: (config) => new DockerConnector(requireConfig(config, 'docker').container),
      materialize: (config, request) => materializeDocker(requireConfig(config, 'docker'), request),
    },
  };
}

function requireConfig<T extends ConnectorType>(
  config: ConnectorConfig,
  expected: T,
): Extract<ConnectorConfig, { type: T }> {
  if (config.type !== expected) {
    throw new Error(`Connector adapter "${expected}" received "${config.type}" config`);
  }
  return config as Extract<ConnectorConfig, { type: T }>;
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
      const registration = adapters[config.type];
      if (!registration) {
        throw new Error(`Connector "${config.type}" is not supported on ${platform}`);
      }
      const adapter = normalizeAdapter(registration);
      const terminalAdapter: TerminalPlanAdapter | undefined = 'materialize' in adapter
        ? {
          materialize: (request) => adapter.materialize(config, request),
          spawn: spawnTerminalPlan,
        }
        : undefined;
      return new ConnectorRuntime(config, adapter.createConnector(config), terminalAdapter);
    },
  });
}

function normalizeAdapter(registration: ConnectorAdapterRegistration):
ConnectorAppOSAdapter | { createConnector: ConnectorAdapterFactory } {
  return typeof registration === 'function'
    ? { createConnector: registration }
    : registration;
}

function spawnTerminalPlan(plan: TerminalLaunchPlan): Shell {
  log.info('connector', `${plan.logContext} bin=${plan.executable} kind=${plan.kind}`);
  return wrapPty(pty.spawn(plan.executable, [...plan.args], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: plan.cwd,
    env: { ...plan.env },
  }));
}

function materializeLocalUnix(request: TerminalLaunchRequest): TerminalLaunchPlan {
  const cwd = fs.existsSync(request.cwd) ? request.cwd : os.homedir();
  const executable = request.kind === TERMINAL_LAUNCH_KIND.compatibility
    ? resolveShell()
    : request.interpreter;
  const args = request.kind === TERMINAL_LAUNCH_KIND.compatibility
    ? ['-l']
    : [...request.interpreterArgs];
  return freezeTerminalLaunchPlan({
    kind: request.kind,
    executable,
    args,
    cwd,
    env: {
      ...applyEnvMap(getShellEnv(), { ...request.env }, { ...request.requiredEnv }),
      HISTFILE: '/dev/null',
    },
    logContext: `local/unix spawn: shell=${executable} cwd=${cwd}`,
  });
}

function materializeLocalWindows(request: TerminalLaunchRequest): TerminalLaunchPlan {
  const cwd = fs.existsSync(request.cwd) ? request.cwd : os.homedir();
  return freezeTerminalLaunchPlan({
    kind: request.kind,
    executable: request.kind === TERMINAL_LAUNCH_KIND.compatibility
      ? 'powershell.exe'
      : request.interpreter,
    args: request.kind === TERMINAL_LAUNCH_KIND.compatibility ? [] : request.interpreterArgs,
    cwd,
    env: applyEnvMap(stringEnv(process.env), { ...request.env }, { ...request.requiredEnv }),
    logContext: `local/win32 spawn: shell=${request.kind === TERMINAL_LAUNCH_KIND.compatibility ? 'powershell.exe' : request.interpreter} cwd=${cwd}`,
  });
}

function materializeSSH(
  config: Extract<ConnectorConfig, { type: 'ssh' }>,
  request: TerminalLaunchRequest,
  controlMaster: boolean,
): TerminalLaunchPlan {
  const options = controlMaster
    ? [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${getControlPath(config.host, config.port, config.user)}`,
      '-o', 'ControlPersist=600',
    ]
    : [];
  const command = targetCommand(request, '$SHELL -l');
  return freezeTerminalLaunchPlan({
    kind: request.kind,
    executable: 'ssh',
    args: [
      ...options,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile="${getKnownHostsPath()}"`,
      '-o', 'ServerAliveInterval=30',
      '-p', String(config.port),
      `${config.user}@${config.host}`,
      '-t', command,
    ],
    cwd: os.homedir(),
    env: controlMaster ? getShellEnv() : stringEnv(process.env),
    logContext: `ssh/${controlMaster ? 'unix' : 'win32'} spawn: ${config.user}@${config.host}:${config.port} cwd=${request.cwd}`,
  });
}

function materializeDocker(
  config: Extract<ConnectorConfig, { type: 'docker' }>,
  request: TerminalLaunchRequest,
): TerminalLaunchPlan {
  return freezeTerminalLaunchPlan({
    kind: request.kind,
    executable: 'docker',
    args: ['exec', '-it', config.container, 'sh', '-c', targetCommand(request, '${SHELL:-sh}')],
    cwd: os.homedir(),
    env: getShellEnv(),
    logContext: `docker spawn: container=${config.container} cwd=${request.cwd}`,
  });
}

function materializeWSL(
  config: Extract<ConnectorConfig, { type: 'wsl' }>,
  request: TerminalLaunchRequest,
): TerminalLaunchPlan {
  return freezeTerminalLaunchPlan({
    kind: request.kind,
    executable: 'wsl.exe',
    args: ['-d', config.distro, '--', 'sh', '-c', targetCommand(request, '$SHELL')],
    cwd: os.homedir(),
    env: stringEnv(process.env),
    logContext: `wsl spawn: distro=${config.distro} cwd=${request.cwd}`,
  });
}

function targetCommand(request: TerminalLaunchRequest, compatibilityInterpreter: string): string {
  const envPrefix = buildEnvExportPrefix({ ...request.env }, { ...request.requiredEnv });
  const interpreter = request.kind === TERMINAL_LAUNCH_KIND.compatibility
    ? compatibilityInterpreter
    : [shellSingleQuote(request.interpreter), ...request.interpreterArgs.map(shellSingleQuote)].join(' ');
  return `${envPrefix}cd ${shellEscape(request.cwd)} && exec ${interpreter}`;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
