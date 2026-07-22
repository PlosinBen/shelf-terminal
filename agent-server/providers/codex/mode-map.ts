// Codex ACP session-mode ↔ Shelf permission-mode mapping (codex-specific — NOT in
// the shared toolkit). Verified from codex-acp's `AgentMode.ts`:
//   read-only          on-request / readOnly sandbox        → Shelf plan
//                        (the safe, no-autonomous-writes bucket — codex's only
//                        write-restricted mode; not a plan→approve→execute flow,
//                        but the closest Shelf semantic)
//   agent (DEFAULT)     on-request / workspace-write         → Shelf default
//   agent-full-access   never-approve / dangerFullAccess     → Shelf bypassPermissions
// codex has no acceptEdits-equivalent, so it exposes only these 3 (per the
// permission-mode integration policy: expose all mappable native modes, hide any
// unmapped — the caller logs those as candidates for a new Shelf mode).

import type { SessionModeState } from '@agentclientprotocol/sdk';
import { pickPermissionModes, type CycleOption, type PermissionModeId } from '../types';

const CODEX_TO_SHELF: Record<string, PermissionModeId> = {
  'read-only': 'plan',
  agent: 'default',
  'agent-full-access': 'bypassPermissions',
};
const SHELF_TO_CODEX: Record<string, string> = {
  plan: 'read-only',
  default: 'agent',
  bypassPermissions: 'agent-full-access',
};

/** Canonical status-bar order (subset of Shelf's permission axis). */
const CANONICAL_ORDER: PermissionModeId[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];

/** Suffix after '#', e.g. `…#agent` → 'agent'. Bare codex ids pass through. */
function modeSuffix(id: string): string {
  const i = id.lastIndexOf('#');
  return i >= 0 ? id.slice(i + 1) : id;
}

/** Codex ACP mode id → Shelf permission-mode id (undefined if unmapped). */
export function codexModeIdToShelf(modeId: string | undefined | null): PermissionModeId | undefined {
  if (!modeId) return undefined;
  return CODEX_TO_SHELF[modeSuffix(modeId)];
}

/**
 * Shelf permission-mode id → the codex ACP mode id to pass to `session/set_mode`.
 * Resolves against the session's advertised modes so we send the EXACT id codex
 * expects. Returns undefined for a Shelf mode codex doesn't support (caller
 * reports rather than silently claiming success).
 */
export function shelfToCodexModeId(shelfMode: string, modes: SessionModeState | undefined | null): string | undefined {
  const suffix = SHELF_TO_CODEX[shelfMode];
  if (!suffix) return undefined;
  return modes?.availableModes?.find((m) => modeSuffix(m.id) === suffix)?.id;
}

/**
 * The Shelf permission modes codex supports, DERIVED from the session's advertised
 * modes (so only what codex actually offers is shown), in canonical order. Unmapped
 * advertised modes are dropped here — {@link codexUnmappedModeIds} surfaces them so
 * the caller can log them (integration policy: fail-loud on an unknown mode).
 */
export function codexPermissionModes(modes: SessionModeState | undefined | null): CycleOption[] {
  const supported = new Set<PermissionModeId>();
  for (const m of modes?.availableModes ?? []) {
    const shelf = codexModeIdToShelf(m.id);
    if (shelf) supported.add(shelf);
  }
  return pickPermissionModes(CANONICAL_ORDER.filter((id) => supported.has(id)));
}

/** Advertised codex mode ids that map to NO Shelf mode — logged as candidates for
 *  a new Shelf permission mode (see the integration policy). */
export function codexUnmappedModeIds(modes: SessionModeState | undefined | null): string[] {
  return (modes?.availableModes ?? []).filter((m) => !codexModeIdToShelf(m.id)).map((m) => m.id);
}
