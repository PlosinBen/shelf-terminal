let tail: Promise<void> = Promise.resolve();

/**
 * Serialize every operation that may repoint or read the shared side-car Git
 * repository. Local payload preparation can happen outside this boundary, but
 * origin/fetch/ref/export/push work cannot interleave across Backup and Import.
 */
export async function withConfigBackupOperation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
