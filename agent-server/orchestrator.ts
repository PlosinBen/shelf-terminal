import { randomUUID } from 'node:crypto';
import { serverLog } from './server-logger';
import { loadContext, saveContext, type PersistedContext } from './context-store';
import type { OutgoingMessage, SendFn } from './providers/types';
import type { AgentProvider } from '@shared/agent-providers';

/**
 * Hydrate persisted context for a execution. Surfaces the row only when the
 * recorded provider matches `provider` — cross-provider data (e.g. Claude
 * session pointer when the active provider is Copilot) is irrelevant and
 * could mislead a provider into resuming an unrelated SDK session.
 */
export function loadRestoreContextFor(
  provider: AgentProvider,
  sessionId: string | undefined,
): PersistedContext | undefined {
  if (!sessionId) return undefined;
  const ctx = loadContext(sessionId);
  if (!ctx || ctx.provider !== provider) return undefined;
  return ctx;
}

/**
 * Wrap the raw `send` to intercept `context_patch` messages: merge the patch
 * into the persisted context for this session and skip forwarding to the main
 * process. This is the single place that touches `context-store` for write —
 * providers stay decoupled from disk I/O.
 *
 * `provider`/`sessionId`/`updatedAt` are owned by the orchestrator (provider
 * patches can't override them); everything else from existing storage / patch
 * is preserved via shallow merge.
 *
 * No-op (returns `raw` unchanged) when `sessionId` is missing — patches with
 * no destination would be silently dropped anyway, this keeps the contract
 * explicit at the wrap site.
 *
 * @param now optional clock injection for tests; defaults to `Date.now`.
 */
/**
 * Generate a unique execution id for a single `handleSend` invocation. Short enough
 * to read in logs (`e-3f8a91c2`); 8 hex chars give 4 billion combinations,
 * which is far more than an agent-server process will ever see in its
 * lifetime. Format intentionally distinct from sessionId so the two don't
 * collide in eyeball debugging.
 */
export function newExecutionId(): string {
  return `e-${randomUUID().slice(0, 8)}`;
}

const SESSION_SCOPED_OUTPUT_TYPES = new Set<OutgoingMessage['type']>([
  'message',
  'stream',
  'error',
  'task_event',
]);

/**
 * Wrap a `send` function so every outgoing message carries the same `executionId`.
 * Each call to `handleSend` in agent-server is one Shelf execution. Its id routes
 * status/control to the matching main-process AsyncIterator; renderable content
 * is session-scoped and deliberately carries no execution ownership.
 *
 * Lifecycle messages (`ready`, `pong`, etc.) are emitted from agent-server
 * outside of `handleSend` and intentionally do NOT carry a executionId — they
 * belong to no specific execution. The main side handles those on a separate
 * dispatch path.
 */
export function wrapSendForExecution(executionId: string, raw: SendFn): SendFn {
  return (msg: OutgoingMessage) => {
    if (SESSION_SCOPED_OUTPUT_TYPES.has(msg.type)) {
      // Content and background-task events outlive execution settlement. Strip a
      // provider-prepopulated id too: the session sink is their sole owner.
      const { executionId: _executionId, ...sessionScoped } = msg;
      raw(sessionScoped as OutgoingMessage);
      return;
    }
    // Respect a pre-set executionId for server-initiated control (`execution_started`).
    raw({ ...msg, executionId: msg.executionId ?? executionId } as OutgoingMessage);
  };
}

export function wrapSendForContext(
  provider: AgentProvider,
  sessionId: string | undefined,
  raw: SendFn,
  now: () => number = Date.now,
): SendFn {
  if (!sessionId) return raw;
  return (msg: OutgoingMessage) => {
    if (msg.type === 'context_patch') {
      try {
        const patch = (msg.patch ?? {}) as Partial<PersistedContext>;
        const current = loadContext(sessionId) ?? {};
        saveContext({
          ...current,
          ...patch,
          sessionId,
          provider,
          updatedAt: now(),
        });
      } catch (err: any) {
        // Persistence is best-effort — never let it break the execution — but
        // also never invisibly: consistent persist failure means user history
        // is being lost, which is a much-harder-to-debug class of bug.
        serverLog('error', 'orchestrator', 'context persistence failed', { sessionId, provider, message: err?.message ?? err });
      }
      return;
    }
    raw(msg);
  };
}
