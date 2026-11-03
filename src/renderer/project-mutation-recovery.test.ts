import { describe, expect, it, vi } from 'vitest';
import { ProjectMutationRefreshError } from './project-mutation-coordinator';
import { createProjectUpdateQueue, runProjectOperationWithRecovery } from './project-mutation-recovery';

describe('project mutation recovery', () => {
  it('keeps a failed report and its retry ahead of a later report for the same project', async () => {
    const queue = createProjectUpdateQueue();
    let decide!: (retry: boolean) => void;
    const order: string[] = [];
    const action = vi.fn(async () => {
      order.push('older');
      if (order.length === 1) throw new Error('disk full');
    });
    const older = queue('p', () => runProjectOperationWithRecovery({
      operation: 'save', action, refresh: async () => {},
      confirmRetry: () => new Promise(resolve => { decide = resolve; }),
    }));
    await vi.waitFor(() => expect(decide).toBeTypeOf('function'));
    const newer = queue('p', async () => { order.push('newer'); });
    await queue('other', async () => { order.push('other project'); });
    expect(order).toEqual(['older', 'other project']);
    decide(true);
    await Promise.all([older, newer]);
    expect(order).toEqual(['older', 'other project', 'older', 'newer']);
  });

  it('does not strand later operations after a rejected queued update', async () => {
    const queue = createProjectUpdateQueue();
    const failed = queue('p', async () => { throw new Error('rejected'); });
    const next = queue('p', async () => 'next');
    await expect(failed).rejects.toThrow('rejected');
    await expect(next).resolves.toBe('next');
  });
  it('retries a mutation that did not commit', async () => {
    const action = vi.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce('saved');
    const refresh = vi.fn(async () => {});
    const confirmRetry = vi.fn(async () => true);

    await expect(runProjectOperationWithRecovery({
      operation: 'save', action, refresh, confirmRetry,
    })).resolves.toEqual({ status: 'completed', value: 'saved' });
    expect(action).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();
    expect(confirmRetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mutation' }));
  });

  it('retries only refresh after a durable commit', async () => {
    const action = vi.fn().mockRejectedValue(
      new ProjectMutationRefreshError('add', 'main-owned-id', new Error('query failed')),
    );
    const refresh = vi.fn(async () => {});
    const confirmRetry = vi.fn(async () => true);

    await expect(runProjectOperationWithRecovery({
      operation: 'add', action, refresh, confirmRetry,
    })).resolves.toEqual({ status: 'completed', value: 'main-owned-id' });
    expect(action).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(confirmRetry).toHaveBeenCalledWith(expect.objectContaining({ kind: 'refresh' }));
  });

  it('leaves the caller in control when the user cancels', async () => {
    const error = new Error('permission denied');
    const action = vi.fn().mockRejectedValue(error);

    await expect(runProjectOperationWithRecovery({
      operation: 'delete',
      action,
      refresh: vi.fn(),
      confirmRetry: vi.fn(async () => false),
    })).resolves.toEqual({ status: 'cancelled', error });
    expect(action).toHaveBeenCalledOnce();
  });

  it('never resends a committed mutation across repeated refresh failures', async () => {
    const action = vi.fn().mockRejectedValue(
      new ProjectMutationRefreshError('delete', { cleanupPending: false }, new Error('query failed')),
    );
    const refresh = vi.fn().mockRejectedValue(new Error('query still failed'));
    const confirmRetry = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(runProjectOperationWithRecovery({
      operation: 'delete', action, refresh, confirmRetry,
    })).resolves.toMatchObject({ status: 'cancelled' });
    expect(action).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(confirmRetry).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'refresh' }));
  });
});
