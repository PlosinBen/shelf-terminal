import { loadContext, saveContext, type PersistedContext } from './context-store';
import type { OutgoingMessage, SendFn } from './providers/types';

/**
 * Hydrate persisted context for a turn. Surfaces the row only when the
 * recorded provider matches `provider` — cross-provider data (e.g. Claude
 * session pointer when the active provider is Copilot) is irrelevant and
 * could mislead a provider into resuming an unrelated SDK session.
 */
export function loadRestoreContextFor(
  provider: string,
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
export function wrapSendForContext(
  provider: string,
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
      } catch {
        // Persistence is best-effort — never let it break the turn.
      }
      return;
    }
    raw(msg);
  };
}
