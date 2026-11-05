import { CONFIG_CONTROL as C, ConfigControlRejectedError, validConfigControl, type ConfigControlUpdate } from '@shared/agent-config-control';
import type { SendQueue, QueuedSend } from './send-queue';
import type { ServerBackend, SendFn } from './providers/types';
import { serverLog } from './server-logger';

/** Independent control lifecycle. Unknown mutation outcomes retain the queue barrier. */
export function createSessionConfigControl<T extends QueuedSend>(queue: SendQueue<T>, report: (update: ConfigControlUpdate) => void, send: SendFn = () => {}) {
  let pending = false;
  return async (request: unknown, backend: ServerBackend | undefined): Promise<void> => {
    if (!validConfigControl(request)) throw new Error('Invalid session configuration request');
    const { requestId, key, value } = request;
    const emit = (state: ConfigControlUpdate['state'], error?: string) => report({ requestId, key, value, state, ...(error ? { error } : {}) });
    if (pending || !backend?.configure || !backend.configRequiresIdle) {
      emit(C.STATE.REJECTED, pending ? 'A session configuration request is already pending' : 'Session configuration is unavailable');
      return;
    }
    let defer: boolean;
    try { defer = backend.configRequiresIdle(request.key); }
    catch (error) { emit(C.STATE.REJECTED, String(error)); return; }
    pending = true;
    emit(C.STATE.DEFERRED);
    try {
      await queue.runControl(async () => {
        emit(C.STATE.APPLYING);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let accepting = true;
        try {
          await Promise.race([
            backend.configure!(request, event => {
              if (!accepting) { serverLog('debug', 'config-control', `ignored late provider confirmation requestId=${requestId}`); return; }
              if (event.type !== 'capabilities') throw new Error(`Unexpected provider config event ${event.type} requestId=${requestId}`);
              send(event);
            }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Session configuration confirmation timed out')), C.APPLY_TIMEOUT_MS); }),
          ]);
          emit(C.STATE.CONFIRMED);
        } catch (error) {
          if (error instanceof ConfigControlRejectedError) { emit(C.STATE.REJECTED, error.message); return; }
          // Setter failures can follow an upstream mutation. Never claim rollback.
          queue.block();
          emit(C.STATE.UNCERTAIN, `${String(error)}. Reconnect before continuing; do not automatically resend.`);
        } finally { accepting = false; clearTimeout(timer); }
      }, defer);
    } catch (error) { emit(C.STATE.REJECTED, String(error)); }
    finally { pending = false; }
  };
}
