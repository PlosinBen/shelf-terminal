import path from 'path';
import os from 'os';
import fs from 'fs';

const CONTROL_DIR = path.join(os.tmpdir(), 'shelf-ssh-control');

export function getControlDir(): string {
  if (!fs.existsSync(CONTROL_DIR)) {
    fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
  }
  return CONTROL_DIR;
}

export function getControlPath(host: string, port: number, user: string): string {
  return path.join(getControlDir(), `${user}@${host}:${port}`);
}

export function checkConnection(host: string, port: number, user: string): boolean {
  const socketPath = getControlPath(host, port, user);
  return fs.existsSync(socketPath);
}

export function cleanupControlSockets(): void {
  if (fs.existsSync(CONTROL_DIR)) {
    fs.rmSync(CONTROL_DIR, { recursive: true, force: true });
  }
}
