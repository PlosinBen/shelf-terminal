import fs from 'fs';
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
 */

const REL_DIR = '.tmp/shelf';

let prefixCounter = 0;

/**
 * Short, time-sortable prefix: base36 timestamp + 1 counter char.
 * ~9 chars total. The counter guards against the rare case of two pastes
 * landing in the same millisecond.
 */
function makePrefix(): string {
  return Date.now().toString(36) + (prefixCounter++ % 36).toString(36);
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

function uploadLocal(cwd: string, filename: string, buffer: Buffer): string {
  const { remoteDir, remotePath } = buildPaths(cwd, filename);
  fs.mkdirSync(remoteDir, { recursive: true });
  fs.writeFileSync(remotePath, buffer);
  return remotePath;
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

function uploadSSH(
  cwd: string,
  filename: string,
  buffer: Buffer,
  host: string,
  port: number,
  user: string,
): Promise<string> {
  const { remoteDir, remotePath } = buildPaths(cwd, filename);
  const controlPath = getControlPath(host, port, user);
  const cmd = `mkdir -p ${shellSingleQuote(remoteDir)} && cat > ${shellSingleQuote(remotePath)}`;
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
  const { remoteDir, remotePath } = buildPaths(cwd, filename);
  const dockerBin = process.env.DOCKER_PATH || '/usr/local/bin/docker';
  const cmd = `mkdir -p ${shellSingleQuote(remoteDir)} && cat > ${shellSingleQuote(remotePath)}`;
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
  const { remoteDir, remotePath } = buildPaths(cwd, filename);
  const cmd = `mkdir -p ${shellSingleQuote(remoteDir)} && cat > ${shellSingleQuote(remotePath)}`;
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

// Exported for unit tests.
export const __test__ = { buildPaths, sanitizeFilename, shellSingleQuote, makePrefix };
