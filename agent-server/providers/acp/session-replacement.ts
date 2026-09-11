/**
 * Sequence a provider-owned session replacement without learning the provider's
 * state shape or protocol. Callers supply every concrete operation; this helper
 * only preserves the fail-closed transaction order.
 */
export async function replaceSession<TSnapshot, TSession>(operations: {
  capture: () => TSnapshot;
  invalidate: () => void | Promise<void>;
  reset: () => void | Promise<void>;
  establish: () => Promise<TSession>;
  initialize: (session: TSession, snapshot: TSnapshot) => void | Promise<void>;
}): Promise<TSession> {
  const snapshot = operations.capture();
  await operations.invalidate();
  await operations.reset();
  const session = await operations.establish();
  await operations.initialize(session, snapshot);
  return session;
}
