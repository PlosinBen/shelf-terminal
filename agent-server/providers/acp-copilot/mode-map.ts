// Copilot ACP session-mode ↔ Shelf permission-mode mapping (copilot-specific —
// NOT in the shared toolkit). Copilot advertises modes agent/plan/autopilot (as
// full-URL ids like `…/session-modes#agent`); Shelf's canonical permission axis
// is default/plan/bypassPermissions. autopilot = "enables allow-all" = bypass.
//
// This mirrors the NATIVE copilot backend's MODE_TO_SDK mapping + its
// `pickPermissionModes(['default','bypassPermissions','plan'])` capability surface,
// so acp-copilot presents IDENTICAL permission semantics — required for parity and
// a clean cutover (users keep the same ask/plan/bypass vocabulary).

import type { SessionModeState } from '@agentclientprotocol/sdk';
import { pickPermissionModes, type CycleOption } from '../types';

const COPILOT_TO_SHELF: Record<string, string> = { agent: 'default', plan: 'plan', autopilot: 'bypassPermissions' };
const SHELF_TO_COPILOT: Record<string, string> = { default: 'agent', plan: 'plan', bypassPermissions: 'autopilot' };

/** Suffix after '#', e.g. `…/session-modes#agent` → 'agent'. Bare ids pass through. */
function modeSuffix(id: string): string {
  const i = id.lastIndexOf('#');
  return i >= 0 ? id.slice(i + 1) : id;
}

/** The Shelf-standard permission modes copilot supports (matches native copilot). */
export function copilotPermissionModes(): CycleOption[] {
  return pickPermissionModes(['default', 'bypassPermissions', 'plan']);
}

/** Copilot ACP current mode id → Shelf permission-mode id (undefined if unknown). */
export function copilotModeIdToShelf(modeId: string | undefined | null): string | undefined {
  if (!modeId) return undefined;
  return COPILOT_TO_SHELF[modeSuffix(modeId)];
}

/**
 * Shelf permission-mode id → the copilot ACP mode id to pass to `session/set_mode`.
 * Resolves against the session's advertised modes so we send the EXACT id copilot
 * expects (full URL). Returns undefined for a Shelf mode copilot doesn't support
 * (e.g. acceptEdits) — caller reports rather than silently claiming success.
 */
export function shelfToCopilotModeId(shelfMode: string, modes: SessionModeState | undefined | null): string | undefined {
  const suffix = SHELF_TO_COPILOT[shelfMode];
  if (!suffix) return undefined;
  return modes?.availableModes?.find((m) => modeSuffix(m.id) === suffix)?.id;
}
