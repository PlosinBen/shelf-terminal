export type StatusSegmentSeverity = 'normal' | 'info' | 'warning' | 'critical';

export interface StatusSegment {
  text: string;
  severity?: StatusSegmentSeverity;
}

/** Map utilization (0-1) to severity. Common UX threshold: 50% warning, 80% critical. */
export function severityFromUtilization(u: number): StatusSegmentSeverity {
  if (u >= 0.8) return 'critical';
  if (u >= 0.5) return 'warning';
  return 'normal';
}

/** Format a millisecond duration as "12d" / "3.2h" / "30m". Returns null if past. */
export function formatResetCountdown(resetsAtMs: number): string | null {
  const d = resetsAtMs - Date.now();
  if (d <= 0) return null;
  if (d >= 86_400_000) return `${Math.round(d / 86_400_000)}d`;
  if (d >= 3_600_000) return `${(d / 3_600_000).toFixed(1)}h`;
  return `${Math.ceil(d / 60_000)}m`;
}

import type { ProviderModel } from '../../src/shared/types';
import type { PersistedContext } from '../context-store';

export type OutgoingMessage = {
  type: 'message' | 'stream' | 'status' | 'error' | 'pong' | 'ready' | 'capabilities' | 'auth_required' | 'permission_request'
    | 'credential_stored' | 'credential_cleared' | 'slash_result'
    /**
     * Internal: provider asks orchestrator to merge `patch` into the persisted
     * context for this session. Intercepted by `agent-server/index.ts` and NOT
     * forwarded to the main process — providers stay decoupled from disk I/O.
     */
    | 'context_patch';
  [key: string]: unknown;
};

export type SlashResult =
  | { type: 'show-model-picker'; models: { value: string; displayName: string; effortLevels?: CycleOption[]; vision?: boolean }[]; current: string }
  | { type: 'switch-model'; model: string }
  | { type: 'context-cleared'; message?: string }
  | { type: 'pass-through' }
  | { type: 'system-message'; content: string }
  | { type: 'error'; message: string };

export type SendFn = (msg: OutgoingMessage) => void;

export interface QueryInput {
  prompt: string;
  cwd: string;
  resume?: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
  images?: string[];
  sessionId?: string;
  /**
   * Pre-loaded persisted context for this session. Orchestrator hydrates this
   * from disk before calling `query()`; providers read whichever fields are
   * relevant to their SDK (e.g. `lastSdkSessionId` for Claude/Copilot resume).
   * Providers MUST NOT import `context-store` directly — emit `context_patch`
   * outgoing messages to update persistence.
   */
  restoreContext?: PersistedContext;
}

/**
 * A cycle-able option in the status bar (mode / effort).
 * Provider decides displayName + severity; renderer cycles by `value`.
 */
export interface CycleOption {
  value: string;
  displayName: string;
  severity?: StatusSegmentSeverity;
}

/**
 * Central UX descriptors for permission modes and effort levels.
 * Provider's job is to declare which IDs it supports; displayName / severity
 * are app-wide concerns (consistency between providers, single point of truth).
 */
export const PERMISSION_MODES = {
  default:           { value: 'default',           displayName: 'ask' },
  acceptEdits:       { value: 'acceptEdits',       displayName: 'acceptEdits',       severity: 'warning' },
  bypassPermissions: { value: 'bypassPermissions', displayName: 'bypassPermissions', severity: 'critical' },
  plan:              { value: 'plan',              displayName: 'plan',              severity: 'info' },
} as const satisfies Record<string, CycleOption>;

export type PermissionModeId = keyof typeof PERMISSION_MODES;

export function pickPermissionModes(ids: PermissionModeId[]): CycleOption[] {
  return ids.map((id) => ({ ...PERMISSION_MODES[id] }));
}

/** Known effort levels. Unknown names (e.g. SDK introduces a new one) fall through identity. */
export const EFFORT_LEVELS: Record<string, CycleOption> = {
  low:    { value: 'low',    displayName: 'low' },
  medium: { value: 'medium', displayName: 'medium' },
  high:   { value: 'high',   displayName: 'high' },
  xhigh:  { value: 'xhigh',  displayName: 'xhigh',  severity: 'info' },
  max:    { value: 'max',    displayName: 'max',    severity: 'warning' },
};

export function pickEffortLevels(values: string[]): CycleOption[] {
  return values.map((v) => EFFORT_LEVELS[v] ? { ...EFFORT_LEVELS[v] } : { value: v, displayName: v });
}

export interface ProviderCapabilities {
  models: { value: string; displayName: string; effortLevels?: CycleOption[]; vision?: boolean }[];
  permissionModes: CycleOption[];
  effortLevels: CycleOption[];
  slashCommands: { name: string; description: string }[];
  authMethod?: unknown;
}

export interface ServerBackend {
  query(input: QueryInput, send: SendFn): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
  gatherCapabilities?(cwd: string, sessionId?: string, customModels?: ProviderModel[]): Promise<ProviderCapabilities>;
  resolvePermission?(toolUseId: string, allow: boolean, message?: string, scope?: 'once' | 'session'): void;
  storeCredential?(key: string): Promise<void>;
  clearCredential?(): Promise<void>;
  handleSlashCommand?(cmd: string, args: string): Promise<SlashResult>;
  /**
   * Drop any in-memory session state tied to `sessionId`. Called by the
   * orchestrator when persisted context is deleted (IPC `clear_context`),
   * so the provider doesn't keep using a `lastSdkSessionId` that no longer
   * exists on disk. Sync — providers should clear refs only, not perform I/O.
   */
  resetSession?(sessionId: string): void;
}
