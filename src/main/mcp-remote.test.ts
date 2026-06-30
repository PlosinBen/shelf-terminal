import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Connection } from '@shared/types';

const transportPut = vi.fn(async () => {});
vi.mock('./connector/transport', () => ({
  transportPut: (...a: unknown[]) => transportPut(...a),
}));

let sourceExists = true;
let sourceHash = 'h1';
vi.mock('./mcp-projection', () => ({
  mcpConfigSourcePath: () => '/ud/mcp-servers.json',
  hashMcpConfig: () => sourceHash,
}));
vi.mock('fs', () => ({ default: { existsSync: () => sourceExists }, existsSync: () => sourceExists }));
vi.mock('./app-instance-id', () => ({ getAppInstanceId: () => 'app-1' }));

const { syncMcpForConnection, __resetMcpSyncGate } = await import('./mcp-remote');

const ssh = { type: 'ssh', host: 'h', user: 'u', port: 22 } as unknown as Connection;
const local = { type: 'local' } as unknown as Connection;

beforeEach(() => {
  transportPut.mockClear();
  __resetMcpSyncGate();
  sourceExists = true;
  sourceHash = 'h1';
});

describe('syncMcpForConnection', () => {
  it('places the config via the transport (type=mcp, appId, source)', async () => {
    await syncMcpForConnection(ssh);
    expect(transportPut).toHaveBeenCalledTimes(1);
    expect(transportPut).toHaveBeenCalledWith(ssh, {
      type: 'mcp',
      context: { appId: 'app-1' },
      source: { localPath: '/ud/mcp-servers.json' },
    });
  });

  it('is a no-op for local (re-projected by onMcpChanged)', async () => {
    await syncMcpForConnection(local);
    expect(transportPut).not.toHaveBeenCalled();
  });

  it('no-ops when there is no source config', async () => {
    sourceExists = false;
    await syncMcpForConnection(ssh);
    expect(transportPut).not.toHaveBeenCalled();
  });

  it('client-side hash-gate skips a redundant re-push, re-syncs on change', async () => {
    await syncMcpForConnection(ssh);
    await syncMcpForConnection(ssh); // unchanged → gated
    expect(transportPut).toHaveBeenCalledTimes(1);
    sourceHash = 'h2'; // config changed
    await syncMcpForConnection(ssh);
    expect(transportPut).toHaveBeenCalledTimes(2);
  });
});
