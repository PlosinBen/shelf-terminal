import { beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '@shared/ipc-channels';
import type { PtySpawnPayload } from '@shared/types';
import { log } from '@shared/logger';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: PtySpawnPayload) => Promise<void>>(),
  launcher: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: (event: unknown, payload: PtySpawnPayload) => Promise<void>) => h.handlers.set(channel, handler),
  on: vi.fn(),
} }));
vi.mock('../pty-manager', () => ({ spawnPty: h.spawn, writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), setMuted: vi.fn() }));
vi.mock('../app-state', () => ({ getMainWindow: () => ({}) }));
vi.mock('../project-env', () => ({ resolveProjectEnv: () => ({ SECRET: 'private-env' }) }));
vi.mock('../connector', () => ({ createConnector: () => ({}) }));
vi.mock('../external-url-launcher', () => ({ ensureExternalUrlLauncher: h.launcher }));
const { registerPtyHandlers } = await import('./pty');

beforeEach(() => { vi.clearAllMocks(); registerPtyHandlers(); });

it('logs the failed preparation boundary and preserves rejection without logging sensitive error text', async () => {
  const info = vi.spyOn(log, 'info').mockImplementation(() => {});
  const error = vi.spyOn(log, 'error').mockImplementation(() => {});
  const failure = new Error('command contains private-env');
  h.launcher.mockImplementation(async (_connector, _connection, _dependencies, stage) => {
    stage('upload:start');
    throw failure;
  });
  try {
    await expect(h.handlers.get(IPC.PTY_SPAWN)!(undefined, {
      projectId: 'p', tabId: 't', cwd: '/private-path', connection: { type: 'wsl', distro: 'Ubuntu' },
    })).rejects.toBe(failure);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('terminal-startup', expect.stringContaining('stage=launcher:upload:start failed'));
    const messages = [...info.mock.calls, ...error.mock.calls].map((call) => call[1]).join('\n');
    expect(messages).toContain('project=p tab=t connection=wsl');
    expect(messages).not.toContain('private');
  } finally { info.mockRestore(); error.mockRestore(); }
});
