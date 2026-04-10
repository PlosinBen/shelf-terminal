import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { app } from 'electron';

// Use short dir path to avoid Unix socket 104-byte limit on macOS
const CONTROL_DIR = path.join(os.tmpdir(), 'shelf-ssh');

export function getControlDir(): string {
  if (!fs.existsSync(CONTROL_DIR)) {
    fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
  }
  return CONTROL_DIR;
}

export function getControlPath(host: string, port: number, user: string): string {
  // Hash to keep path short — Unix domain socket max is 104 bytes on macOS
  const hash = crypto.createHash('sha256').update(`${user}@${host}:${port}`).digest('hex').slice(0, 16);
  return path.join(getControlDir(), hash);
}

export function checkConnection(host: string, port: number, user: string): boolean {
  const socketPath = getControlPath(host, port, user);
  return fs.existsSync(socketPath);
}

export function cleanupControlSockets(): void {
  if (!fs.existsSync(CONTROL_DIR)) return;

  // Send `ssh -O exit` to each socket to terminate the master process,
  // otherwise ControlPersist keeps it alive in the background.
  for (const file of fs.readdirSync(CONTROL_DIR)) {
    const sock = path.join(CONTROL_DIR, file);
    try {
      execFileSync('ssh', ['-o', `ControlPath=${sock}`, '-O', 'exit', 'dummy'], {
        timeout: 2000,
        stdio: 'ignore',
      });
    } catch {
      // Ignore — master may already be gone
    }
  }
  fs.rmSync(CONTROL_DIR, { recursive: true, force: true });
}

// ── Known hosts ──

export function getKnownHostsPath(): string {
  const p = path.join(app.getPath('userData'), 'ssh_known_hosts');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return p;
}

/**
 * Remove a host key entry from Shelf's known_hosts file.
 */
export function removeHostKey(host: string, port: number): void {
  const knownHostsPath = getKnownHostsPath();
  if (!fs.existsSync(knownHostsPath)) return;

  const content = fs.readFileSync(knownHostsPath, 'utf-8');
  const marker = port === 22 ? host : `[${host}]:${port}`;
  const filtered = content
    .split('\n')
    .filter((line) => !line.startsWith(marker + ' ') && !line.startsWith(marker + '\t'))
    .join('\n');
  fs.writeFileSync(knownHostsPath, filtered, 'utf-8');
}
