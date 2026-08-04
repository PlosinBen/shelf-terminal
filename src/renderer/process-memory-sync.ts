import type { ProcessMemorySummary } from '@shared/process-memory';
import { setProcessMemorySummary } from './store';

/**
 * Bind the app-wide memory stream before hydrating its cached value. A push
 * received while the getter is in flight wins, so an older cache response
 * cannot overwrite the newer complete snapshot.
 */
export function bindProcessMemorySummary(): () => void {
  let disposed = false;
  let receivedPush = false;

  const off = window.shelfApi.agent.onMemoryUsage((summary: ProcessMemorySummary) => {
    receivedPush = true;
    setProcessMemorySummary(summary);
  });

  void window.shelfApi.agent.getMemoryUsage()
    .then((summary) => {
      if (!disposed && !receivedPush && summary) setProcessMemorySummary(summary);
    })
    .catch((error: unknown) => {
      window.shelfApi.app.debugLog(
        'process-memory',
        `failed to hydrate memory summary: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

  return () => {
    disposed = true;
    off();
  };
}
