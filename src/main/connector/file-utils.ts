import { spawn } from 'child_process';

/**
 * Shared file-transfer utilities for all connectors.
 * Upload prefix parsing, path building, and remote pipe writing.
 */

const REL_DIR = '.tmp/shelf';
const GITIGNORE_REL = '.tmp/.gitignore';

const MIN_PREFIX_LEN = 9;
const TS_FLOOR_MS = 1_577_836_800_000; // 2020-01-01
const TS_CEIL_MS = 4_102_444_800_000;  // 2100-01-01

let prefixCounter = 0;

export { REL_DIR, GITIGNORE_REL };

export function normalizeCwd(cwd: string): string {
  return cwd.replace(/\/+$/, '');
}

export function assertSafeCwd(cwd: string): void {
  const trimmed = cwd.trim();
  if (trimmed.length === 0) throw new Error('refusing to operate on empty cwd');
  if (trimmed === '/') throw new Error('refusing to operate on root cwd');
}

export function makePrefix(): string {
  return Date.now().toString(36) + (prefixCounter++ % 36).toString(36);
}

export function parseUploadPrefix(name: string): number | null {
  const dashIdx = name.indexOf('-');
  if (dashIdx < MIN_PREFIX_LEN) return null;
  const prefix = name.slice(0, dashIdx);
  if (prefix.length < MIN_PREFIX_LEN) return null;
  if (!/^[a-z0-9]+$/.test(prefix)) return null;
  const timestampPart = prefix.slice(0, -1);
  const ms = parseInt(timestampPart, 36);
  if (!Number.isFinite(ms)) return null;
  if (ms < TS_FLOOR_MS || ms >= TS_CEIL_MS) return null;
  return ms;
}

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[/\\]/g, '_').replace(/[\x00-\x1f]/g, '');
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned;
}

export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface PathParts {
  remoteDir: string;
  remotePath: string;
}

export function buildPaths(cwd: string, filename: string): PathParts {
  const finalName = `${makePrefix()}-${sanitizeFilename(filename)}`;
  const remoteDir = `${normalizeCwd(cwd)}/${REL_DIR}`;
  return { remoteDir, remotePath: `${remoteDir}/${finalName}` };
}

/**
 * Build the remote shell snippet that mkdir's the upload dir, drops a
 * `.tmp/.gitignore` (if missing), then `cat`s stdin into the destination.
 */
export function buildRemoteUploadCmd(cwd: string, remoteDir: string, remotePath: string): string {
  const tmpDir = `${normalizeCwd(cwd)}/.tmp`;
  const gitignorePath = `${tmpDir}/.gitignore`;
  const gitignoreGuard = `{ [ -f ${shellSingleQuote(gitignorePath)} ] || printf '*\\n' > ${shellSingleQuote(gitignorePath)}; }`;
  return [
    `mkdir -p ${shellSingleQuote(remoteDir)}`,
    gitignoreGuard,
    `cat > ${shellSingleQuote(remotePath)}`,
  ].join(' && ');
}

/**
 * Spawn a process, pipe `buffer` to stdin, resolve with `remotePath` on
 * success. Used by SSH, Docker, and WSL upload paths.
 */
export function spawnPipeWrite(
  bin: string,
  args: string[],
  buffer: Buffer,
  remotePath: string,
  label: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve(remotePath);
      else reject(new Error(`${label} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
    child.stdin.end(buffer);
  });
}

/**
 * Run a command on a remote transport and return stdout.
 */
export function spawnRemoteCmd(
  bin: string,
  args: string[],
  label: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${label} exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

/**
 * List files in `<cwd>/.tmp/shelf/` on a remote transport.
 * Returns parsed file names (excluding `.` and `..`).
 */
export async function listRemoteShelfDir(
  bin: string,
  args: (cmd: string) => string[],
  cwd: string,
  label: string,
): Promise<string[]> {
  const dir = `${normalizeCwd(cwd)}/${REL_DIR}`;
  const cmd = `ls -1a ${shellSingleQuote(dir)} 2>/dev/null || true`;
  try {
    const out = await spawnRemoteCmd(bin, args(cmd), label);
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== '.' && s !== '..');
  } catch {
    return [];
  }
}

/**
 * Delete files from the remote shelf dir.
 */
export async function removeRemoteFiles(
  bin: string,
  args: (cmd: string) => string[],
  cwd: string,
  files: string[],
  label: string,
): Promise<void> {
  const dir = `${normalizeCwd(cwd)}/${REL_DIR}`;
  const quoted = files.map((name) => shellSingleQuote(`${dir}/${name}`)).join(' ');
  await spawnRemoteCmd(bin, args(`rm -rf ${quoted}`), label);
}
