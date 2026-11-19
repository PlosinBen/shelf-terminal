import { posix, win32 } from 'node:path';

/** Display-only: use the source environment's path syntax, never inspect the FS. */
export function displayFilePath(value: string, cwd?: string): string {
  if (!cwd) return value;
  const paths = /^(?:[a-z]:[\\/]|\\\\)/i.test(cwd) ? win32 : posix;
  if (!paths.isAbsolute(cwd) || !paths.isAbsolute(value)) return value;
  const relative = paths.relative(cwd, value);
  if (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) return value;
  return relative || '.';
}
