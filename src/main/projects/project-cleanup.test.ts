import { describe, expect, it, vi } from 'vitest';
import { createProjectCleanup } from './project-cleanup';

describe('project cleanup', () => {
  it('attempts storage and secrets cleanup in the same run', async () => {
    const removeStorage = vi.fn(async () => {});
    const removeSecrets = vi.fn(() => {});
    const cleanup = createProjectCleanup({ removeStorage, removeSecrets });

    await cleanup.cleanup('project-a');

    expect(removeStorage).toHaveBeenCalledWith('project-a');
    expect(removeSecrets).toHaveBeenCalledWith('project-a');
  });

  it('reports failure after still attempting both cleanup targets', async () => {
    const removeStorage = vi.fn(async () => {
      throw new Error('storage failed');
    });
    const removeSecrets = vi.fn(() => {
      throw new Error('secrets failed');
    });
    const cleanup = createProjectCleanup({ removeStorage, removeSecrets });

    await expect(cleanup.cleanup('project-a')).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.any(Error), expect.any(Error)],
    });
    expect(removeStorage).toHaveBeenCalledOnce();
    expect(removeSecrets).toHaveBeenCalledOnce();
  });
});
