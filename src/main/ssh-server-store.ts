import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { log } from '../shared/logger';

export interface SSHServer {
  host: string;
  port: number;
  user: string;
}

function getFilePath(): string {
  return path.join(app.getPath('userData'), 'ssh-servers.json');
}

export function loadSSHServers(): SSHServer[] {
  try {
    const raw = fs.readFileSync(getFilePath(), 'utf-8');
    return JSON.parse(raw) as SSHServer[];
  } catch {
    return [];
  }
}

export function saveSSHServer(server: SSHServer): void {
  const servers = loadSSHServers();
  const exists = servers.some(
    (s) => s.host === server.host && s.port === server.port && s.user === server.user,
  );
  if (exists) return;

  servers.push(server);
  try {
    fs.writeFileSync(getFilePath(), JSON.stringify(servers, null, 2), 'utf-8');
    log.info('ssh-servers', `saved server: ${server.user}@${server.host}:${server.port}`);
  } catch (err: any) {
    log.error('ssh-servers', `failed to save: ${err?.message ?? err}`);
  }
}
