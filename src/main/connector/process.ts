import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { applyEnvMap, buildEnvExportPrefix } from '@shared/project-env';
import type { ExecResult, ProcessRequest } from './types';
import { shellSingleQuote } from './file-utils';
import { getShellEnv } from './shell-env';

export const FILE_COPY_TIMEOUT_MS = 180_000;

/** File-path transfer: never load runtime payloads into a main-process Buffer. */
export function copyWithCommand(executable: string, args: string[], context: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: FILE_COPY_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${context}: ${stderr || error.message}`));
      else resolve();
    });
  });
}

/** Picker fallback paths cannot be used as authoritative deployment destinations. */
export async function resolvePosixHome(exec: () => Promise<ExecResult>, context: string): Promise<string> {
  let result: ExecResult;
  try {
    result = await exec();
  } catch (error) {
    throw new Error(`${context} resolve home failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const home = result.stdout.trim();
  if (!path.posix.isAbsolute(home) || /[\r\n\0]/.test(home)) {
    throw new Error(`${context} resolve home returned an invalid absolute path`);
  }
  return home;
}

/** No PTY: stdout is the caller's byte protocol, stderr remains diagnostic output. */
export function spawnLocalProcess(request: ProcessRequest): ChildProcessWithoutNullStreams {
  return spawn(request.executable, [...request.args], {
    cwd: request.cwd,
    env: applyEnvMap(getShellEnv(), request.env ?? {}, request.requiredEnv ?? {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function remoteProcessCommand(request: ProcessRequest): string {
  const init = request.initScript ? `eval ${shellSingleQuote(request.initScript)} >/dev/null 2>&1; ` : '';
  const cwd = request.cwd ? `cd ${shellSingleQuote(request.cwd)} || exit $?; ` : '';
  const env = buildEnvExportPrefix(request.env ?? {}, request.requiredEnv ?? {});
  return `${init}${cwd}${env}exec ${[request.executable, ...request.args].map(shellSingleQuote).join(' ')}`;
}

export function toWslPath(winPath: string): string {
  return winPath.replace(/^([A-Za-z]):\\/, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/');
}
