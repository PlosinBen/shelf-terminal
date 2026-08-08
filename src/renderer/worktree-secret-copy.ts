export type WorktreeSecretCopyResult = 'copied' | 'cancelled' | 'stale';

export async function copyWorktreeSecretsWithRecovery(options: {
  readonly isCurrent: () => boolean;
  readonly copy: () => Promise<void>;
  readonly confirmRetry: (error: unknown) => Promise<boolean>;
}): Promise<WorktreeSecretCopyResult> {
  while (options.isCurrent()) {
    try {
      await options.copy();
      return options.isCurrent() ? 'copied' : 'stale';
    } catch (error) {
      if (!options.isCurrent()) return 'stale';
      if (!await options.confirmRetry(error)) return 'cancelled';
    }
  }
  return 'stale';
}
