import { describe, expect, it } from 'vitest';
import { withConfigBackupOperation } from './operation-lock';

describe('config-backup operation lock', () => {
  it('serializes operations and releases the queue after a failure', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withConfigBackupOperation(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
      throw new Error('expected failure');
    });
    const second = withConfigBackupOperation(async () => {
      order.push('second');
      return 2;
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await expect(first).rejects.toThrow('expected failure');
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });
});
