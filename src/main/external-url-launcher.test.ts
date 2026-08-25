import { describe, expect, it, vi } from 'vitest';
import type { Connector } from './connector/types';
import {
  ensureExternalUrlLauncher,
  externalUrlLauncherAssetPaths,
} from './external-url-launcher';

function connector(overrides: Partial<Connector> = {}): Connector {
  return {
    createShell: vi.fn() as never,
    isConnected: vi.fn() as never,
    connect: vi.fn() as never,
    exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    listDir: vi.fn() as never,
    homePath: vi.fn(async () => '/home/tester'),
    uploadFile: vi.fn() as never,
    putFile: vi.fn(async () => {}),
    cleanupSession: vi.fn() as never,
    clearUploads: vi.fn() as never,
    getUploadsSize: vi.fn() as never,
    ...overrides,
  };
}

describe('external URL launcher deployment', () => {
  it('selects unpackaged and packaged resource paths per platform', () => {
    expect(externalUrlLauncherAssetPaths({
      platform: 'darwin', isPackaged: false, appPath: '/repo', resourcesPath: '/bundle',
    })).toEqual({
      browser: '/repo/resources/external-url-launcher/shelf-browser',
      powershell: '/repo/resources/external-url-launcher/shelf-browser.ps1',
      windowsCommand: '/repo/resources/external-url-launcher/shelf-browser.cmd',
    });
    expect(externalUrlLauncherAssetPaths({
      platform: 'win32', isPackaged: true, appPath: 'C:\\app', resourcesPath: 'C:\\Shelf\\resources',
    }).windowsCommand).toBe('C:\\Shelf\\resources\\external-url-launcher\\shelf-browser.cmd');
  });

  it('uses the local POSIX launcher without deploying it', async () => {
    const target = connector();
    const access = vi.fn();

    await expect(ensureExternalUrlLauncher(target, { type: 'local' }, {
      platform: 'linux',
      isPackaged: false,
      appPath: '/repo',
      resourcesPath: '/resources',
      access,
      readFile: vi.fn(),
    })).resolves.toBe('/repo/resources/external-url-launcher/shelf-browser');
    expect(access).toHaveBeenCalledOnce();
    expect(target.putFile).not.toHaveBeenCalled();
  });

  it('requires both local Windows launcher files and returns the cmd entrypoint', async () => {
    const access = vi.fn();
    await expect(ensureExternalUrlLauncher(connector(), { type: 'local' }, {
      platform: 'win32',
      isPackaged: true,
      appPath: 'C:\\app',
      resourcesPath: 'C:\\Shelf\\resources',
      access,
      readFile: vi.fn(),
    })).resolves.toBe('C:\\Shelf\\resources\\external-url-launcher\\shelf-browser.cmd');
    expect(access).toHaveBeenCalledTimes(2);
  });

  it.each([
    { type: 'ssh', host: 'example.com', port: 22, user: 'tester' } as const,
    { type: 'docker', container: 'dev' } as const,
    { type: 'wsl', distro: 'Ubuntu' } as const,
  ])('deploys and chmods the POSIX launcher for $type', async (connection) => {
    const putFile = vi.fn(async () => {});
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const target = connector({
      homePath: vi.fn(async () => "/home/tester's space"),
      putFile,
      exec,
    });
    const body = Buffer.from('#!/bin/sh\n');

    await expect(ensureExternalUrlLauncher(target, connection, {
      platform: 'darwin',
      isPackaged: false,
      appPath: '/repo',
      resourcesPath: '/resources',
      access: vi.fn(),
      readFile: vi.fn(() => body),
    })).resolves.toBe("/home/tester's space/.shelf/external-url/1/shelf-browser");

    expect(putFile).toHaveBeenCalledWith(
      "/home/tester's space/.shelf/external-url/1/shelf-browser",
      body,
    );
    expect(exec).toHaveBeenCalledWith(
      "/home/tester's space",
      "chmod 700 '/home/tester'\\''s space/.shelf/external-url/1/shelf-browser'",
    );
  });
});
