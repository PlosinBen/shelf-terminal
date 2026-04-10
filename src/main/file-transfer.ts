import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { Connection } from '../shared/types';
import { getControlPath, getKnownHostsPath } from './ssh-control';
import { log } from '../shared/logger';

/**
 * Generic file uploader for paste/drag-drop. All connection types route through
 * here so the renderer doesn't need to know about ssh/docker/wsl plumbing.
 *
 * Files land at `<projectCwd>/.tmp/shelf/<prefix>-<filename>`. The .tmp/shelf
 * subdirectory is chosen because it lives inside the project (so it doesn't hit
 * permission walls when the agent CLI is sandboxed to the project, e.g. Gemini)
 * and is git-ignorable by convention.
 *
 * For SSH/Docker/WSL we pipe the buffer over `sh -c "mkdir -p ... && cat > ..."`
 * via stdin. This avoids scp/docker-cp staging files entirely and lets shell
 * single-quoting handle paths with spaces and other awkward characters.
 *
 * Cleanup model: every uploaded filename starts with a base36-encoded ms
 * timestamp. On the first pty spawn for a project we kick off a background
 * cleanup that lists `.tmp/shelf/` and deletes any file whose decoded
 * timestamp is *older than this Shelf process startup*. That guarantees we
 * never touch files created during the current session, even if the user
 * pastes the moment cleanup runs.
 */

const REL_DIR = '.tmp/shelf';
const GITIGNORE_REL = '.tmp/.gitignore';

/**
 * Marks the start of *this* Shelf process. Anything older than this is leftover
 * from previous sessions and is safe to delete.
 */
export const SESSION_STARTED_AT = Date.now();

let prefixCounter = 0;

/**
 * Short, time-sortable prefix: base36 timestamp + 1 counter char.
 * ~9 chars total. The counter guards against the rare case of two pastes
 * landing in the same millisecond.
 */
function makePrefix(): string {
  return Date.now().toString(36) + (prefixCounter++ % 36).toString(36);
}

/**
 * Sanity window for decoded prefix timestamps. `Date.now().toString(36)` is
 * 8 characters wide for any time between ~1972 and ~2059, so a real Shelf
 * prefix is exactly 9 chars. We additionally require the decoded ms to fall
 * inside [2020-01-01, 2100-01-01) — that way an arbitrary all-alphanumeric
 * word like `manually-placed.log` does not get misclassified as one of ours.
 */
const MIN_PREFIX_LEN = 9;
const TS_FLOOR_MS = 1_577_836_800_000; // 2020-01-01T00:00:00Z
const TS_CEIL_MS = 4_102_444_800_000;  // 2100-01-01T00:00:00Z

/**
 * Parse the ms timestamp out of an uploaded filename. Returns null when the
 * name does not look like one of ours — that way unknown files (e.g. user's
 * own scratch files dropped into `.tmp/shelf/`) are skipped by cleanup.
 */
function parseUploadPrefix(name: string): number | null {
  const dashIdx = name.indexOf('-');
  if (dashIdx < MIN_PREFIX_LEN) return null;
  const prefix = name.slice(0, dashIdx);
  if (prefix.length < MIN_PREFIX_LEN) return null;
  if (!/^[a-z0-9]+$/.test(prefix)) return null;
  // Last char is the counter; everything before it is the base36 timestamp.
  const timestampPart = prefix.slice(0, -1);
  const ms = parseInt(timestampPart, 36);
  if (!Number.isFinite(ms)) return null;
  if (ms < TS_FLOOR_MS || ms >= TS_CEIL_MS) return null;
  return ms;
}

function sanitizeFilename(name: string): string {
  // Strip path separators and control chars but otherwise preserve the original
  // name. Shell-special characters are handled by single-quoting at the call site.
  const cleaned = name.replace(/[/\\]/g, '_').replace(/[\x00-\x1f]/g, '');
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned;
}

interface PathParts {
  remoteDir: string;
  remotePath: string;
}

function buildPaths(cwd: string, filename: string): PathParts {
  const finalName = `${makePrefix()}-${sanitizeFilename(filename)}`;
  const remoteDir = `${cwd.replace(/\/+$/, '')}/${REL_DIR}`;
  return { remoteDir, remotePath: `${remoteDir}/${finalName}` };
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\/+$/, '');
}

/**
 * Throws on cwd values that would make rm/find dangerously broad.
 * Used by both upload and cleanup paths.
 */
function assertSafeCwd(cwd: string): void {
  const trimmed = cwd.trim();
  if (trimmed.length === 0) throw new Error('refusing to operate on empty cwd');
  if (trimmed === '/') throw new Error('refusing to operate on root cwd');
}

function uploadLocal(cwd: string, filename: string, buffer: Buffer): string {
  assertSafeCwd(cwd);
  const { remoteDir, remotePath } = buildPaths(cwd, filename);
  fs.mkdirSync(remoteDir, { recursive: true });
  ensureLocalGitignore(cwd);
  fs.writeFileSync(remotePath, buffer);
  return remotePath;
}

function ensureLocalGitignore(cwd: string): void {
  try {
    const gitignorePath = path.join(normalizeCwd(cwd), GITIGNORE_REL);
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, '*\n');
    }
  } catch (err: any) {
    log.debug('file-transfer', `gitignore write skipped: ${err?.message ?? err}`);
  }
}

function spawnPipeWrite(
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
 * Build the remote shell snippet that mkdir's the upload dir, drops a
 * `.tmp/.gitignore` (if missing), then `cat`s stdin into the destination.
 * Used by every remote transport so they all stay in lockstep.
 */
function buildRemoteUploadCmd(cwd: string, remoteDir: string, remotePath: string): string {
  const tmpDir = `${normalizeCwd(cwd)}/.tmp`;
  const gitignorePath = `${tmpDir}/.gitignore`;
  const gitignoreGuard = `{ [ -f ${shellSingleQuote(gitignorePath)} ] || printf '*\\n' > ${shellSingleQuote(gitignorePath)}; }`;
  return [
    `mkdir -p ${shellSingleQuote(remoteDir)}`,
    gitignoreGuard,
    `cat > ${shellSingleQuote(remotePath)}`,
  ].join(' && ');
}

function uploadSSH(
  cwd: string,
  filename: string,
  buffer: Buffer,
  host: string,
  port: number,
  user: string,
): Promise<string> {
  assertSafeCwd(cwd);
  const { remoteDir, remotePath } = buildPaths(cwd, filename);
  const controlPath = getControlPath(host, port, user);
  const cmd = buildRemoteUploadCmd(cwd, remoteDir, remotePath);
  return spawnPipeWrite(
    'ssh',
    [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${controlPath}`,
      '-o', 'ControlPersist=600',
      '-o', `UserKnownHostsFile="${getKnownHostsPath()}"`,
      '-p', String(port),
      `${user}@${host}`,
      cmd,
    ],
    buffer,
    remotePath,
    'ssh upload',
  );
}

function uploadDocker(
  cwd: string,
  filename: string,
  buffer: Buffer,
  container: string,
): Promise<string> {
  assertSafeCwd(cwd);
  const { remoteDir, remotePath } = buildPaths(cwd, filename);
  const dockerBin = process.env.DOCKER_PATH || '/usr/local/bin/docker';
  const cmd = buildRemoteUploadCmd(cwd, remoteDir, remotePath);
  return spawnPipeWrite(
    dockerBin,
    ['exec', '-i', container, 'sh', '-c', cmd],
    buffer,
    remotePath,
    'docker upload',
  );
}

function uploadWSL(
  cwd: string,
  filename: string,
  buffer: Buffer,
  distro: string,
): Promise<string> {
  assertSafeCwd(cwd);
  const { remoteDir, remotePath } = buildPaths(cwd, filename);
  const cmd = buildRemoteUploadCmd(cwd, remoteDir, remotePath);
  return spawnPipeWrite(
    'wsl.exe',
    ['-d', distro, '--', 'sh', '-c', cmd],
    buffer,
    remotePath,
    'wsl upload',
  );
}

export async function uploadFile(
  connection: Connection,
  cwd: string,
  filename: string,
  buffer: Buffer,
): Promise<string> {
  log.debug('file-transfer', `upload ${filename} (${buffer.length}B) → ${connection.type}:${cwd}`);
  switch (connection.type) {
    case 'local':
      return uploadLocal(cwd, filename, buffer);
    case 'ssh':
      return uploadSSH(cwd, filename, buffer, connection.host, connection.port, connection.user);
    case 'docker':
      return uploadDocker(cwd, filename, buffer, connection.container);
    case 'wsl':
      return uploadWSL(cwd, filename, buffer, connection.distro);
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────

/**
 * List the names in `<cwd>/.tmp/shelf/` for the given connection. Each
 * transport returns the entries newline-separated; missing directory is
 * treated as "no entries".
 */
async function listShelfDir(connection: Connection, cwd: string): Promise<string[]> {
  const dir = `${normalizeCwd(cwd)}/${REL_DIR}`;

  if (connection.type === 'local') {
    try {
      return fs.readdirSync(dir);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
  }

  // Remote: `ls -1a` and filter out `.` / `..` on our side. `2>/dev/null`
  // swallows "no such file" so a missing dir returns an empty list.
  const cmd = `ls -1a ${shellSingleQuote(dir)} 2>/dev/null || true`;
  const out = await runRemote(connection, cmd);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
}

function runRemote(connection: Connection, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let bin: string;
    let args: string[];
    switch (connection.type) {
      case 'ssh': {
        const controlPath = getControlPath(connection.host, connection.port, connection.user);
        bin = 'ssh';
        args = [
          '-o', 'ControlMaster=auto',
          '-o', `ControlPath=${controlPath}`,
          '-o', 'ControlPersist=600',
          '-o', `UserKnownHostsFile="${getKnownHostsPath()}"`,
          '-p', String(connection.port),
          `${connection.user}@${connection.host}`,
          cmd,
        ];
        break;
      }
      case 'docker': {
        bin = process.env.DOCKER_PATH || '/usr/local/bin/docker';
        args = ['exec', connection.container, 'sh', '-c', cmd];
        break;
      }
      case 'wsl': {
        bin = 'wsl.exe';
        args = ['-d', connection.distro, '--', 'sh', '-c', cmd];
        break;
      }
      default:
        return reject(new Error(`runRemote: unsupported connection type ${(connection as any).type}`));
    }

    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${connection.type} exec exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

/**
 * Delete every file in `<cwd>/.tmp/shelf/` whose filename-encoded timestamp
 * is older than `cutoffMs`. Files we don't recognize (no valid prefix) are
 * left alone.
 *
 * Returns the number of entries removed (best-effort — does not throw on
 * individual rm failures).
 */
export async function cleanupSession(
  connection: Connection,
  cwd: string,
  cutoffMs: number,
): Promise<number> {
  assertSafeCwd(cwd);

  const entries = await listShelfDir(connection, cwd);
  const stale = entries.filter((name) => {
    const ts = parseUploadPrefix(name);
    return ts !== null && ts < cutoffMs;
  });
  if (stale.length === 0) return 0;

  const dir = `${normalizeCwd(cwd)}/${REL_DIR}`;

  if (connection.type === 'local') {
    let removed = 0;
    for (const name of stale) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
        removed++;
      } catch (err: any) {
        log.debug('file-transfer', `local rm failed for ${name}: ${err?.message ?? err}`);
      }
    }
    return removed;
  }

  // Remote: build a single `rm -f` invocation with each name shell-quoted.
  const quoted = stale.map((name) => shellSingleQuote(`${dir}/${name}`)).join(' ');
  await runRemote(connection, `rm -f ${quoted}`);
  return stale.length;
}

/**
 * Manual purge: delete *every* file in `<cwd>/.tmp/shelf/` regardless of
 * timestamp. Used by the "Clear uploaded files" button. Keeps the directory
 * itself in place so future uploads don't have to recreate it.
 */
export async function clearUploads(connection: Connection, cwd: string): Promise<number> {
  assertSafeCwd(cwd);

  const entries = await listShelfDir(connection, cwd);
  if (entries.length === 0) return 0;

  const dir = `${normalizeCwd(cwd)}/${REL_DIR}`;

  if (connection.type === 'local') {
    let removed = 0;
    for (const name of entries) {
      try {
        fs.rmSync(path.join(dir, name), { force: true, recursive: true });
        removed++;
      } catch (err: any) {
        log.debug('file-transfer', `local clear rm failed for ${name}: ${err?.message ?? err}`);
      }
    }
    return removed;
  }

  const quoted = entries.map((name) => shellSingleQuote(`${dir}/${name}`)).join(' ');
  await runRemote(connection, `rm -rf ${quoted}`);
  return entries.length;
}

/**
 * Schedule a one-off background cleanup for `projectId` the first time we
 * see it. Subsequent spawns are no-ops, so the deletion only runs once per
 * (project × Shelf process). Errors are logged and swallowed — cleanup is
 * best-effort and must never block pty startup.
 */
const cleanedProjects = new Set<string>();

export function maybeScheduleCleanup(projectId: string, connection: Connection, cwd: string): void {
  if (!projectId || cleanedProjects.has(projectId)) return;
  // For empty/root cwd we just skip rather than throwing — this runs in the
  // background of pty spawn and we don't want to spam errors for, e.g., a
  // misconfigured project.
  if (!cwd || cwd.trim() === '' || cwd.trim() === '/') return;
  cleanedProjects.add(projectId);

  setTimeout(() => {
    cleanupSession(connection, cwd, SESSION_STARTED_AT)
      .then((n) => {
        if (n > 0) log.info('file-transfer', `session cleanup removed ${n} stale upload(s) in ${cwd}`);
      })
      .catch((err) => {
        log.info('file-transfer', `session cleanup skipped for ${cwd}: ${err?.message ?? err}`);
      });
  }, 3000);
}

// Test-only hook so unit tests can reset the dedupe set between cases.
export function __resetCleanupTracking(): void {
  cleanedProjects.clear();
}

// Exported for unit tests.
export const __test__ = {
  buildPaths,
  sanitizeFilename,
  shellSingleQuote,
  makePrefix,
  parseUploadPrefix,
  assertSafeCwd,
  buildRemoteUploadCmd,
};
