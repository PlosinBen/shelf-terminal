import { randomUUID } from 'node:crypto';
import { APP_EXIT_DECISION, APP_EXIT_PREPARE_TIMEOUT_MS, type AppExitDecision, type AppExitRequest } from '@shared/app-exit';

class RendererUnresponsive extends Error {}

/** Keep all destructive work behind one successful prepare (or explicit force).
 * Native close and before-quit callers must preventDefault synchronously. */
export function createAppExitController(deps: {
  prepare: (requestId: string) => Promise<void>;
  cancel: (requestId: string) => void;
  prompt: (failure: { error: unknown; unresponsive: boolean }) => Promise<AppExitDecision>;
  quit: () => void;
  timeoutMs?: number;
}) {
  let pending: Promise<boolean> | null = null;
  let committed = false;
  async function run(commit: () => void) {
    for (;;) {
      const requestId = randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          deps.prepare(requestId),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new RendererUnresponsive('Renderer did not confirm history was saved')), deps.timeoutMs ?? APP_EXIT_PREPARE_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        clearTimeout(timer);
        deps.cancel(requestId);
        const unresponsive = error instanceof RendererUnresponsive;
        const decision = await deps.prompt({ error, unresponsive });
        if (decision === APP_EXIT_DECISION.RETRY) continue;
        if (decision !== APP_EXIT_DECISION.FORCE) return false;
        if (!unresponsive) throw new Error('Force exit is only permitted after an unresponsive renderer');
      } finally {
        clearTimeout(timer);
      }
      committed = true;
      try { commit(); }
      catch (error) {
        committed = false;
        deps.cancel(requestId);
        throw error;
      }
      return true;
    }
  }
  return {
    committed: () => committed,
    preparing: () => pending !== null,
    request(commit = deps.quit): Promise<boolean> {
      if (committed) return Promise.resolve(true);
      if (pending) return pending;
      const attempt = run(commit);
      pending = attempt;
      void attempt.then(() => { pending = null; }, () => { pending = null; });
      return attempt;
    },
  };
}

/** Correlated handshake, with no renderer-supplied global "ready" flag. */
export function createAppExitBridge(deps: {
  send: (request: AppExitRequest, cancelled: boolean) => void;
  isCurrentSender: (sender: unknown) => boolean;
  warn: (message: string) => void;
}) {
  let pending: { requestId: string; resolve: () => void; reject: (error: Error) => void } | null = null;
  return {
    prepare(requestId: string): Promise<void> {
      if (pending) throw new Error(`Exit preparation already pending: ${pending.requestId}`);
      return new Promise((resolve, reject) => {
        pending = { requestId, resolve, reject };
        try { deps.send({ requestId }, false); }
        catch (error) { pending = null; reject(new RendererUnresponsive(`Cannot contact renderer: ${String(error)}`)); }
      });
    },
    cancel(requestId: string) {
      if (pending?.requestId === requestId) {
        pending.reject(new Error(`Exit preparation cancelled: ${requestId}`));
        pending = null;
      }
      deps.send({ requestId }, true);
    },
    accept(sender: unknown, result: unknown): boolean {
      if (!deps.isCurrentSender(sender) || !result || typeof result !== 'object'
        || !pending || !('requestId' in result) || typeof result.requestId !== 'string' || result.requestId !== pending.requestId || !('ok' in result)
        || (result.ok !== true && (result.ok !== false || !('error' in result) || typeof result.error !== 'string'))) {
        deps.warn('Ignored invalid or stale exit preparation acknowledgement');
        return false;
      }
      const current = pending!;
      pending = null;
      if (result.ok === true) current.resolve();
      else current.reject(new Error('error' in result ? String(result.error) : 'Invalid exit failure response'));
      return true;
    },
  };
}
