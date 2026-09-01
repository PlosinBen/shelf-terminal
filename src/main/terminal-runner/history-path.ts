import path from 'path';
import type { ExecResult } from '../connector';
import { shellSingleQuote } from '../connector/file-utils';

export type HistoryShell = 'zsh' | 'bash';

interface TargetCommandRuntime {
  homePath(): Promise<string>;
  exec(cwd: string, cmd: string): Promise<ExecResult>;
}

export interface TargetHistoryPaths {
  readonly projectRoot: string;
  readonly historyRoot: string;
  readonly zsh: string;
  readonly bash: string;
  readonly zshShimDir: string;
  readonly zshShim: string;
}

export interface TargetHistorySelection extends TargetHistoryPaths {
  readonly historyFile: string;
}

export function deriveTargetHistoryPaths(
  home: string,
  appId: string,
  projectId: string,
): TargetHistoryPaths {
  if (!path.posix.isAbsolute(home)) throw new Error(`Target home must be absolute: ${home}`);
  assertNamespaceId('appId', appId);
  assertNamespaceId('projectId', projectId);

  const appRoot = path.posix.join(home, '.shelf', 'apps', appId);
  const projectRoot = path.posix.join(appRoot, 'projects', projectId);
  const historyRoot = path.posix.join(projectRoot, 'shell-history');
  const zshShimDir = path.posix.join(appRoot, 'shell-init', 'zsh', 'v1');
  return Object.freeze({
    projectRoot,
    historyRoot,
    zsh: path.posix.join(historyRoot, 'zsh'),
    bash: path.posix.join(historyRoot, 'bash'),
    zshShimDir,
    zshShim: path.posix.join(zshShimDir, '.zshenv'),
  });
}

export async function ensureTargetHistory(
  runtime: TargetCommandRuntime,
  shell: HistoryShell,
  appId: string,
  projectId: string,
): Promise<TargetHistorySelection> {
  const home = await runtime.homePath();
  const paths = deriveTargetHistoryPaths(home, appId, projectId);
  const historyFile = paths[shell];
  await runtime.exec(home, [
    'umask 077',
    `mkdir -p ${shellSingleQuote(paths.historyRoot)}`,
    `touch ${shellSingleQuote(historyFile)}`,
    `chmod 700 ${shellSingleQuote(paths.historyRoot)}`,
    `chmod 600 ${shellSingleQuote(historyFile)}`,
  ].join(' && '));
  return Object.freeze({ ...paths, historyFile });
}

export async function removeTargetProjectHistory(
  runtime: TargetCommandRuntime,
  appId: string,
  projectId: string,
): Promise<string> {
  const home = await runtime.homePath();
  const { projectRoot } = deriveTargetHistoryPaths(home, appId, projectId);
  await runtime.exec(home, `rm -rf -- ${shellSingleQuote(projectRoot)}`);
  return projectRoot;
}

function assertNamespaceId(name: string, value: string): void {
  if (!value || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${name} for target history namespace`);
  }
}
