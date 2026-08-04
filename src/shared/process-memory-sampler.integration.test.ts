import { describe, expect, it } from 'vitest';
import { snapshotProcesses } from './process-memory-sampler';

const supported = process.platform === 'darwin'
  || process.platform === 'linux'
  || process.platform === 'win32';

describe.runIf(supported)('host process-memory acquisition', () => {
  it('uses the real platform adapter and includes this Node process', async () => {
    const rows = await snapshotProcesses();
    const current = rows.find((row) => row.pid === process.pid);

    expect(rows.length).toBeGreaterThan(0);
    expect(current).toBeDefined();
    expect(current?.memoryKiB).toBeGreaterThan(0);
  });
});
