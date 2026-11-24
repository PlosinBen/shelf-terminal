import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { readRemotePreviewBytes } from './preview-read';

const runtime = (script: string) => ({
  isCurrentGeneration: () => true,
  isConnected: async () => true,
  spawnProcess: vi.fn(() => spawn(process.execPath, ['-e', script])),
});

describe('bounded remote preview transport', () => {
  it('times out and terminates a reader that never closes', async () => {
    const remote = runtime('setInterval(() => {}, 1000)');
    await expect(readRemotePreviewBytes(remote, '/file', 100)).rejects.toThrow('timed out');
    expect(remote.spawnProcess.mock.results[0].value.killed).toBe(true);
  });
  it('bounds connection probes without starting a reader', async () => {
    const remote = { ...runtime(''), isConnected: () => new Promise<boolean>(() => {}) };
    await expect(readRemotePreviewBytes(remote, '/file', 20)).rejects.toThrow('timed out');
    expect(remote.spawnProcess).not.toHaveBeenCalled();
  });
  it.each([
    ['process.stdout.write(Buffer.alloc(2 * 1024 * 1024))', 'output limit'],
    ['process.stderr.write(Buffer.alloc(16384))', 'diagnostic output'],
    ['process.stdout.write("unframed banner or file content")', 'framing'],
    ['process.exit(45)', 'permissions'],
  ])('rejects untrusted output/lifecycle: %s', async (script, reason) => {
    await expect(readRemotePreviewBytes(runtime(script), '/file')).rejects.toThrow(reason);
  });
  it('rejects data when the runtime generation changes while reading', async () => {
    const remote = runtime('');
    remote.spawnProcess.mockImplementation(() => {
      remote.isCurrentGeneration = () => false;
      return spawn(process.execPath, ['-e', '']);
    });
    await expect(readRemotePreviewBytes(remote, '/file')).rejects.toThrow('changed');
  });
});
