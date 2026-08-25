import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { Connection } from '@shared/types';
import type { Connector } from './connector/types';
import { shellSingleQuote } from './connector/file-utils';

const REMOTE_LAUNCHER_RELATIVE_PATH = '.shelf/external-url/1/shelf-browser';

interface LauncherPathInput {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}

export function externalUrlLauncherAssetPaths(input: LauncherPathInput) {
  const pathImpl = input.platform === 'win32' ? path.win32 : path.posix;
  const root = input.isPackaged
    ? pathImpl.join(input.resourcesPath, 'external-url-launcher')
    : pathImpl.join(input.appPath, 'resources', 'external-url-launcher');
  return {
    browser: pathImpl.join(root, 'shelf-browser'),
    powershell: pathImpl.join(root, 'shelf-browser.ps1'),
    windowsCommand: pathImpl.join(root, 'shelf-browser.cmd'),
  };
}

interface ExternalUrlLauncherDependencies extends LauncherPathInput {
  access: (filePath: string, mode?: number) => void;
  readFile: (filePath: string) => Buffer;
}

function defaultDependencies(): ExternalUrlLauncherDependencies {
  return {
    platform: process.platform,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    access: fs.accessSync,
    readFile: (filePath) => fs.readFileSync(filePath),
  };
}

export async function ensureExternalUrlLauncher(
  connector: Connector,
  connection: Connection,
  dependencies: ExternalUrlLauncherDependencies = defaultDependencies(),
): Promise<string> {
  const assets = externalUrlLauncherAssetPaths(dependencies);
  if (connection.type === 'local') {
    if (dependencies.platform === 'win32') {
      dependencies.access(assets.windowsCommand, fs.constants.R_OK);
      dependencies.access(assets.powershell, fs.constants.R_OK);
      return assets.windowsCommand;
    }
    dependencies.access(assets.browser, fs.constants.X_OK);
    return assets.browser;
  }

  const home = await connector.homePath();
  if (!path.posix.isAbsolute(home)) {
    throw new Error(`Cannot deploy external URL launcher: target home is not absolute (${home})`);
  }
  const remotePath = path.posix.join(home, REMOTE_LAUNCHER_RELATIVE_PATH);
  await connector.putFile(remotePath, dependencies.readFile(assets.browser));
  await connector.exec(home, `chmod 700 ${shellSingleQuote(remotePath)}`);
  return remotePath;
}
