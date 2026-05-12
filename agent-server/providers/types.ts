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

/**
 * Envelope present on every outgoing message produced inside a turn. Lifecycle
 * messages (`ready`, `pong`, `capabilities`, `credential_*`) are emitted
 * outside any turn and intentionally omit `turnId`. Main side routes per-turn
 * events back to AsyncIterators by this id; lifecycle is
 * dispatched separately.
 */
export interface WireEnvelope {
  turnId?: string;
}

/** Top-level discriminator for canonical conversation messages in the timeline. */
export type CanonicalMsgType =
  | 'text' | 'thinking' | 'intent' | 'system' | 'error' | 'plan'
  | 'tool_use' | 'file_edit';

/**
 * Outgoing wire message from agent-server to main. Each variant is a
 * concrete discriminated shape — no `[key: string]: unknown` escape hatch.
 * Adding a new wire event means adding a new variant here AND a matching
 * parse case in `src/main/agent/remote.ts`.
 */
export type OutgoingMessage = WireEnvelope & (
  // ── Lifecycle (no turnId) ────────────────────────────────────────────────
  | { type: 'ready' }
  | { type: 'pong' }
  /**
   * Capabilities is dual-purpose: usually a one-shot RPC response carrying
   * `requestId` (matched in main's onResponse map), but providers may also
   * emit unsolicited updates on model/mode change. requestId optional to
   * cover both. Main side ignores requestId-less variants currently (they
   * fall through parseRemoteMessage); this stays open for future use.
   */
  | ({ type: 'capabilities'; requestId?: string; error?: string } & Partial<ProviderCapabilities> & {
      currentModel?: string;
      currentEffort?: string;
      currentPermissionMode?: string;
    })
  | { type: 'credential_stored'; requestId: string; ok: boolean; error?: string }
  | { type: 'credential_cleared'; requestId: string; ok: boolean; error?: string }

  // ── Per-turn control / status (turnId expected) ──────────────────────────
  | {
      type: 'status';
      state: 'streaming' | 'idle';
      model?: string;
      sessionId?: string;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      numTurns?: number;
      contextUsage?: StatusSegment;
      rateLimits?: StatusSegment[];
    }
  | { type: 'error'; error: string }
  | { type: 'auth_required'; provider: string }
  | { type: 'permission_request'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  /**
   * Generic N-way selection prompt. Provider asks renderer to display a
   * picker and resolve with the chosen value (or cancellation). Mirrors the
   * permission_request channel — same pairing pattern, just N options
   * instead of allow/deny. Used by /model (step 9) and any future picker
   * (effort, perm-mode, etc.). `id` is provider-minted, echoed back via
   * resolve_picker IPC.
   */
  | {
      type: 'picker_request';
      id: string;
      title: string;
      options: { value: string; label: string; description?: string; badges?: string[] }[];
      currentValue?: string;
      searchable?: boolean;
      /**
       * Optional hint that this picker resolves into a renderer-side agent
       * preference (saved to project config + pushed to backend via setPrefs).
       * When set, renderer treats the picked value as the authoritative new
       * pref, persists it, updates the status bar locally, and skips the
       * normal capability-drift sync — provider doesn't need to round-trip
       * the change back via a `capabilities` emit just to update the UI.
       *
       * Without `prefKey`, renderer just resolves the picker; what to do
       * with the value is purely the provider's concern.
       */
      prefKey?: 'model' | 'effort' | 'permissionMode';
    }
  /**
   * Internal: provider asks orchestrator to merge `patch` into the persisted
   * context for this session. Intercepted by `agent-server/index.ts` and NOT
   * forwarded to the main process — providers stay decoupled from disk I/O.
   */
  | { type: 'context_patch'; patch: Partial<PersistedContext> }

  // ── Streaming (incremental text/thinking chunks) ─────────────────────────
  // `msgId` ties each chunk to the eventual `type: 'message'` finalize event
  // with the same id. Renderer upserts by msgId — stream chunks append to a
  // placeholder entry that the finalize replaces.
  | { type: 'stream'; msgId: string; streamType: 'text' | 'thinking'; content: string }

  // ── Canonical conversation messages ──────────────────────────────────────
  // Renderer-facing variants. Discriminated by `msgType`. Each variant only
  // carries fields it actually needs (see .agent/features/AGENT_VIEW_MSG_TYPE.md
  // "Canonical Message — Discriminated Union" for design rationale).
  //
  // `msgId` is the upsert key in the renderer's message store. For tool_use
  // and file_edit, `msgId === toolUseId` — they're the same identity. We
  // keep `toolUseId` as a named field too because permission_request uses
  // that name to pair tool runs with their permission flow.
  | { type: 'message'; msgId: string; msgType: 'text';     content: string }
  | { type: 'message'; msgId: string; msgType: 'thinking'; content: string }
  | { type: 'message'; msgId: string; msgType: 'intent';   content: string }
  | { type: 'message'; msgId: string; msgType: 'system';   content: string }
  | { type: 'message'; msgId: string; msgType: 'error';    content: string }
  | { type: 'message'; msgId: string; msgType: 'plan';     content: string }
  | {
      type: 'message'; msgId: string; msgType: 'tool_use';
      toolUseId: string;  // === msgId; kept named for permission_request pairing
      toolName: string;
      input: string;
      result?: { content: string; isError?: boolean };
    }
  | {
      type: 'message'; msgId: string; msgType: 'file_edit';
      toolUseId: string;  // === msgId
      filePath: string;
      diff?: { oldString: string; newString: string };
      content?: string;
      result?: { success: boolean; error?: string };
    }
  | {
      // Provider-emitted slash command response. Renderer is opaque to
      // `slashCmd` — only `status` drives styling. Provider emits pending
      // first, then success/error with the same msgId (upsert pattern).
      type: 'message'; msgId: string; msgType: 'slash_response';
      slashCmd: string;
      status: 'pending' | 'success' | 'error';
      content: string;
    }
);


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
  /**
   * Resolve a pending picker_request by id. `value` is null for cancellation
   * (user pressed Esc), else the chosen option's value. Provider's internal
   * Promise for that picker resolves with this.
   */
  resolvePicker?(id: string, value: string | null): void;

  /**
   * Imperative pref setters. Orchestrator drives diff detection (sessionId-keyed
   * `lastAppliedPrefs` map in agent-server/index.ts) and calls these only when
   * a value differs from the last applied. Providers implement only the ones
   * relevant to their SDK — Claude uses per-call `options.model` so it leaves
   * these unimplemented; Copilot's session needs `session.setModel(...)` etc.
   *
   * Methods are imperative ("apply this now"), not idempotent diff-detectors.
   * Caller (orchestrator) guarantees only-on-change semantics.
   */
  setModel?(model: string): Promise<void> | void;
  setEffort?(effort: string): Promise<void> | void;
  setPermissionMode?(mode: string): Promise<void> | void;
  storeCredential?(key: string): Promise<void>;
  clearCredential?(): Promise<void>;
  /**
   * Drop any in-memory session state tied to `sessionId`. Called by the
   * orchestrator when persisted context is deleted (IPC `clear_context`),
   * so the provider doesn't keep using a `lastSdkSessionId` that no longer
   * exists on disk. Sync — providers should clear refs only, not perform I/O.
   */
  resetSession?(sessionId: string): void;
}
