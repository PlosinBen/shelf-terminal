/**
 * agent-server → main bridge for app-level capabilities. An in-process bridge
 * tool (registered per-provider) calls `callMain(op, args)`; this emits an
 * `app_tool` request on stdout (matched by requestId, modelled on the
 * permission/picker round-trip) and resolves when main replies with
 * `app_tool_result`. Lives in its own module so both index.ts (which owns the
 * stdout `send` + the stdin reader) and the providers can import it without a
 * circular dependency. See .agent/features/app-level-capabilities.md.
 */

export interface AppToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

type Send = (msg: { type: 'app_tool'; requestId: string; op: string; args: Record<string, unknown> }) => void;

let send: Send | null = null;
let seq = 0;
const pending = new Map<string, (r: AppToolResult) => void>();

/** Wire the stdout sender once at boot (index.ts). */
export function initAppToolClient(s: Send): void {
  send = s;
}

/** Call a main-side app tool and await its result. Never rejects — a missing
 *  channel or main-side failure comes back as `{ ok:false, error }`. */
export function callMain(op: string, args: Record<string, unknown> = {}): Promise<AppToolResult> {
  if (!send) return Promise.resolve({ ok: false, error: 'app-tool channel not initialized' });
  seq += 1;
  const requestId = `at-${seq}`;
  return new Promise<AppToolResult>((resolve) => {
    pending.set(requestId, resolve);
    send!({ type: 'app_tool', requestId, op, args });
  });
}

/** Called by index.ts when an `app_tool_result` arrives on stdin. */
export function resolveAppToolResult(requestId: string, result: AppToolResult): void {
  const resolve = pending.get(requestId);
  if (resolve) {
    pending.delete(requestId);
    resolve(result);
  }
}
