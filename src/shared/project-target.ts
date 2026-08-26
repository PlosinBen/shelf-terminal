import type { Connection } from './types';

export interface ProjectTarget {
  readonly connection: Connection;
  readonly cwd: string;
}

const TRAILING_SEPARATORS = /[\\/]+$/;
const DRIVE_PREFIX = /^[A-Za-z]:$/;
const UNC_SHARE_ROOT = /^[\\/]{2}[^\\/]+[\\/][^\\/]+$/;

export function normalizeProjectCwd(cwd: string): string {
  const trailing = cwd.match(TRAILING_SEPARATORS)?.[0];
  if (!trailing) return cwd;

  const base = cwd.slice(0, -trailing.length);
  if (!base || DRIVE_PREFIX.test(base) || UNC_SHARE_ROOT.test(base)) {
    return `${base}${trailing[0]}`;
  }
  return base;
}

export function projectTargetKey(target: ProjectTarget): string {
  const cwd = normalizeProjectCwd(target.cwd);
  switch (target.connection.type) {
    case 'local':
      return JSON.stringify(['local', cwd]);
    case 'ssh':
      return JSON.stringify([
        'ssh',
        target.connection.user,
        target.connection.host,
        target.connection.port,
        cwd,
      ]);
    case 'wsl':
      return JSON.stringify(['wsl', target.connection.distro, cwd]);
    case 'docker':
      return JSON.stringify(['docker', target.connection.container, cwd]);
    default: {
      const unmodelled: never = target.connection;
      const type = (unmodelled as { type?: unknown }).type;
      throw new Error(`unmodelled project connection type: ${String(type)}`);
    }
  }
}

export function sameProjectTarget(first: ProjectTarget, second: ProjectTarget): boolean {
  return projectTargetKey(first) === projectTargetKey(second);
}
