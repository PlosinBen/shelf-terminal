import { describe, expect, it, vi } from 'vitest';
import { copyWorktreeSecretsWithRecovery } from './worktree-secret-copy';

describe('worktree secret copy recovery', () => {
  it('retries the same committed child without creating another project', async () => {
    const copy = vi.fn()
      .mockRejectedValueOnce(new Error('keychain busy'))
      .mockResolvedValueOnce(undefined);
    const confirmRetry = vi.fn(async () => true);

    await expect(copyWorktreeSecretsWithRecovery({
      isCurrent: () => true,
      copy,
      confirmRetry,
    })).resolves.toBe('copied');
    expect(copy).toHaveBeenCalledTimes(2);
    expect(confirmRetry).toHaveBeenCalledOnce();
  });

  it('stops before copying when the committed child is stale', async () => {
    const copy = vi.fn(async () => {});

    await expect(copyWorktreeSecretsWithRecovery({
      isCurrent: () => false,
      copy,
      confirmRetry: vi.fn(),
    })).resolves.toBe('stale');
    expect(copy).not.toHaveBeenCalled();
  });

  it('lets the user cancel without auto-continuing', async () => {
    const copy = vi.fn().mockRejectedValue(new Error('keychain locked'));

    await expect(copyWorktreeSecretsWithRecovery({
      isCurrent: () => true,
      copy,
      confirmRetry: vi.fn(async () => false),
    })).resolves.toBe('cancelled');
    expect(copy).toHaveBeenCalledOnce();
  });
});
