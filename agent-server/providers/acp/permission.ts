// Permission bridge — shared acp/ toolkit (protocol mechanics, semantics-free).
//
// Maps ACP `session/request_permission` (agent asks to run a tool) onto Shelf's
// `permission_request` wire event, and resolves the agent's awaiting request when
// the renderer answers via `resolvePermission`. The allow/deny + once/session
// choice is mapped to the matching ACP PermissionOption kind.

import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  PermissionOption,
  PermissionOptionKind,
} from '@agentclientprotocol/sdk';
import type { OutgoingMessage, SendFn } from '../types';
import type { PermissionHandler } from './connection';

interface Pending {
  resolve: (r: RequestPermissionResponse) => void;
  options: PermissionOption[];
}

/** Desired option kind for an allow/deny decision at a given scope. */
function desiredKind(allow: boolean, scope: 'once' | 'session' | undefined): PermissionOptionKind {
  if (allow) return scope === 'session' ? 'allow_always' : 'allow_once';
  return scope === 'session' ? 'reject_always' : 'reject_once';
}

/** Pick the option id matching the decision; fall back to any allow/reject option. */
export function pickOptionId(
  options: PermissionOption[],
  allow: boolean,
  scope: 'once' | 'session' | undefined,
): string | undefined {
  const want = desiredKind(allow, scope);
  const exact = options.find((o) => o.kind === want);
  if (exact) return exact.optionId;
  const prefix = allow ? 'allow' : 'reject';
  return options.find((o) => o.kind.startsWith(prefix))?.optionId;
}

export interface PermissionBridge {
  /** Register on the ACP connection (client side). */
  onRequestPermission: PermissionHandler;
  /** Renderer's answer for `toolUseId`; resolves the agent's awaiting request. */
  resolvePermission(toolUseId: string, allow: boolean, message?: string, scope?: 'once' | 'session'): void;
  /** Reject all pending requests as cancelled (turn abort / dispose). */
  cancelAll(): void;
}

/**
 * Create a permission bridge. `getSend` returns the CURRENT turn's send (the
 * request must ride the active turn's lane), or null when no turn is live.
 */
export function createPermissionBridge(getSend: () => SendFn | null): PermissionBridge {
  const pending = new Map<string, Pending>();

  const onRequestPermission: PermissionHandler = ({ params }: { params: RequestPermissionRequest }) => {
    const toolUseId = params.toolCall.toolCallId;
    const toolName = params.toolCall.title ?? 'tool';
    const input = (params.toolCall.rawInput as Record<string, unknown> | undefined) ?? {};
    const send = getSend();
    if (!send) {
      // No live turn to ask on — fail closed (cancelled) rather than hang.
      return { outcome: { outcome: 'cancelled' } } satisfies RequestPermissionResponse;
    }
    const msg: OutgoingMessage = { type: 'permission_request', toolUseId, toolName, input };
    // Register the pending entry BEFORE sending: a client that resolves
    // synchronously in response to `send` must find the entry already present,
    // else the resolve is a no-op and the agent's request hangs forever.
    const result = new Promise<RequestPermissionResponse>((resolve) => {
      pending.set(toolUseId, { resolve, options: params.options });
    });
    send(msg);
    return result;
  };

  function resolvePermission(toolUseId: string, allow: boolean, _message?: string, scope?: 'once' | 'session'): void {
    const p = pending.get(toolUseId);
    if (!p) return;
    pending.delete(toolUseId);
    const optionId = pickOptionId(p.options, allow, scope);
    p.resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
  }

  function cancelAll(): void {
    for (const p of pending.values()) p.resolve({ outcome: { outcome: 'cancelled' } });
    pending.clear();
  }

  return { onRequestPermission, resolvePermission, cancelAll };
}
