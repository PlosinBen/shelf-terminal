import { ProjectMutationRefreshError } from './project-mutation-coordinator';

/** Preserve per-project submission order through retries, not only one IPC call.
 * Main still owns canonical merging; this queue never reads or captures a base. */
export function createProjectUpdateQueue() {
  const pending = new Map<string, Promise<unknown>>();
  return function enqueue<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = pending.get(projectId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    pending.set(projectId, result);
    const clear = () => { if (pending.get(projectId) === result) pending.delete(projectId); };
    void result.then(clear, clear);
    return result;
  };
}

export interface ProjectRecoveryPrompt {
  readonly operation: string;
  readonly kind: 'mutation' | 'refresh';
  readonly error: unknown;
}

export type ProjectRecoveryResult<T> =
  | { readonly status: 'completed'; readonly value: T }
  | { readonly status: 'cancelled'; readonly error: unknown };

export async function runProjectOperationWithRecovery<T>(options: {
  readonly operation: string;
  readonly action: () => Promise<T>;
  readonly refresh: () => Promise<void>;
  readonly confirmRetry: (prompt: ProjectRecoveryPrompt) => Promise<boolean>;
}): Promise<ProjectRecoveryResult<T>> {
  let attempt: () => Promise<T> = options.action;

  while (true) {
    try {
      return { status: 'completed', value: await attempt() };
    } catch (error) {
      const refreshFailure = error instanceof ProjectMutationRefreshError;
      const retry = await options.confirmRetry({
        operation: options.operation,
        kind: refreshFailure ? 'refresh' : 'mutation',
        error,
      });
      if (!retry) return { status: 'cancelled', error };

      if (refreshFailure) {
        const committedResult = error.committedResult as T;
        attempt = async () => {
          try {
            await options.refresh();
            return committedResult;
          } catch (refreshError) {
            throw new ProjectMutationRefreshError(error.operation, committedResult, refreshError);
          }
        };
      } else {
        attempt = options.action;
      }
    }
  }
}
