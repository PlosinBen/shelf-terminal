import { validateAgentInputMessage, type AgentInputMessage } from '@shared/agent-input';
import { SUBMISSION_ERROR as E, QUEUE_PROJECTION as P, submissionFailed, type QueueProjection, type SubmissionResult } from '@shared/agent-submission';
import type { AgentQueueItem } from '@shared/types';

interface SubmitOptions {
  projection?: QueueProjection;
  onReceived?: () => void;
  onDispatch?: () => void;
}

/** agent-core#13: owns submission confirmation, never provider completion or Caller presentation. */
export function createMessageSender<T>(deps: {
  target: (tabId: string) => T | undefined;
  execute: (target: T, message: AgentInputMessage, written: () => void) => Promise<unknown>;
  report: (context: string, error: unknown) => void;
  timeoutMs?: number;
}) {
  interface Pending {
    written: boolean; received: boolean; projection: QueueProjection;
    resolve: (result: SubmissionResult) => void; onReceived?: () => void;
    timer: ReturnType<typeof setTimeout>;
  }
  const tabs = new Map<string, Map<string, Pending>>();
  const report = (tabId: string, msgId: string, error: unknown) => deps.report(`tabId=${tabId} msgId=${msgId}`, error);
  function finish(tabId: string, id: string, p: Pending, reason: string) {
    const entries = tabs.get(tabId);
    if (entries?.get(id) !== p) return;
    clearTimeout(p.timer);
    entries.delete(id);
    if (!entries.size) tabs.delete(tabId);
    if (!p.received) p.resolve(submissionFailed(p.written ? E.UNCONFIRMED : E.NOT_SENT, reason));
  }
  return {
    submit(tabId: string, input: AgentInputMessage, options: SubmitOptions = {}): Promise<SubmissionResult> {
      const checked = validateAgentInputMessage(input);
      if (!checked.ok) return Promise.resolve(submissionFailed(E.INVALID, checked.error));
      const message = checked.message;
      const target = deps.target(tabId);
      if (!target) return Promise.resolve(submissionFailed(E.TARGET_MISSING, 'Target Agent View is not available'));
      const entries = tabs.get(tabId) ?? new Map<string, Pending>();
      if (entries.has(message.msgId)) return Promise.resolve(submissionFailed(E.DUPLICATE, 'Message is already being submitted'));
      let resolve!: Pending['resolve'];
      const result = new Promise<SubmissionResult>(r => { resolve = r; });
      const timer = setTimeout(() => {
        const error = submissionFailed(E.TIMEOUT, 'Queue confirmation timed out; delivery is unknown. Do not automatically resend.');
        report(tabId, message.msgId, error);
        resolve(error);
      }, deps.timeoutMs ?? 10_000);
      timer.unref?.();
      const p: Pending = { written: false, received: false, projection: options.projection ?? P.OPTIMISTIC, resolve, timer, onReceived: options.onReceived };
      entries.set(message.msgId, p); tabs.set(tabId, entries);
      // Register before starting: even an immediate running snapshot must match.
      try {
        options.onDispatch?.();
        void deps.execute(target, message, () => { p.written = true; })
          .catch(error => report(tabId, message.msgId, error))
          .finally(() => finish(tabId, message.msgId, p, 'Execution ended without queue confirmation'));
      } catch (error) {
        report(tabId, message.msgId, error);
        finish(tabId, message.msgId, p, String(error));
      }
      return result;
    },
    snapshot(tabId: string, items: AgentQueueItem[]) {
      const entries = tabs.get(tabId);
      for (const item of items) {
        const p = entries?.get(item.clientMsgId);
        if (!p || p.received) continue;
        p.received = true; clearTimeout(p.timer);
        // Callback is a separate notification, including after timeout. Its failure
        // cannot erase a queue receipt or prevent other items from being processed.
        try { p.onReceived?.(); } catch (error) { report(tabId, item.clientMsgId, error); }
        p.resolve({ ok: true });
      }
      return items.filter(item => entries?.get(item.clientMsgId)?.projection !== P.MIRRORED);
    },
    close(tabId: string) {
      for (const [id, p] of tabs.get(tabId) ?? []) finish(tabId, id, p, 'Target Agent View closed before queue confirmation');
    },
  };
}
