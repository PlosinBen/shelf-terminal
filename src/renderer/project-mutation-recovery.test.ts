import { describe, expect, it, vi } from 'vitest';
import { ProjectMutationRefreshError } from './project-mutation-coordinator';
import { runProjectOperationWithRecovery } from './project-mutation-recovery';

describe('project mutation recovery', () => {
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
