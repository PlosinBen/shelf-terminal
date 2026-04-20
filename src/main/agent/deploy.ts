import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { log } from '@shared/logger';
import { createConnector } from '../connector';
import type { Connection } from '@shared/types';

function getVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function getLocalBundlePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent-server');
  }
  return path.join(app.getAppPath(), 'dist', 'agent-server', getVersion());
}

export async function ensureRemoteDeploy(connection: Connection, cwd: string, initScript?: string): Promise<{ remotePath: string; version: string } | { error: string }> {
  const version = getVersion();
  const remoteDir = `~/.shelf/agent-server/${version}`;
  const connector = createConnector(connection);

  const shellPrefix = initScript
    ? `eval ${shellQuote(initScript)} >/dev/null 2>&1; `
    : '';

  try {
    const checkResult = await connector.exec(cwd, `${shellPrefix}test -f ${remoteDir}/index.js && echo EXISTS`);
    if (checkResult.stdout.trim() === 'EXISTS') {
      log.info('agent-deploy', `Remote agent-server v${version} already deployed`);
      return { remotePath: remoteDir, version };
    }
  } catch {
    // Not deployed yet
  }

  log.info('agent-deploy', `Deploying agent-server v${version} to remote...`);

  try {
    await connector.exec(cwd, `mkdir -p ${remoteDir}`);
  } catch (err: any) {
    return { error: `Failed to create remote directory: ${err.message}` };
  }

  const localDir = getLocalBundlePath();

  const indexPath = path.join(localDir, 'index.js');
  if (!fs.existsSync(indexPath)) {
    return { error: `Local agent-server bundle not found at ${indexPath}` };
  }

  try {
    const indexBuf = fs.readFileSync(indexPath);
    await connector.uploadFile(remoteDir, 'index.js', indexBuf);
  } catch (err: any) {
    return { error: `Failed to upload index.js: ${err.message}` };
  }

  const cliSrcPath = path.join(localDir, 'cli.js');
  if (fs.existsSync(cliSrcPath)) {
    try {
      const cliBuf = fs.readFileSync(cliSrcPath);
      await connector.uploadFile(remoteDir, 'cli.js', cliBuf);
    } catch (err: any) {
      return { error: `Failed to upload cli.js: ${err.message}` };
    }
  }

  log.info('agent-deploy', `Agent-server v${version} deployed successfully`);
  return { remotePath: remoteDir, version };
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
