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

import type { ProviderModel } from '@shared/types';
import type { PersistedContext } from '../context-store';

/**
 * Renderer → provider response to a picker_request. Answers are index-aligned
 * with the request's `prompts[]`. Each answer is `string` for single-select /
 * free-text or `string[]` for multi-select (renderer narrows via
 * `Array.isArray`). `cancelled: true` is dispatched when the user dismisses
 * the picker (Cancel button, Esc) — provider should release any pending
 * resources and respond to the upstream agent in the appropriate cancel form.
 */
export type PickerResolvePayload =
  | { answers: Array<string | string[]> }
  | { cancelled: true };

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

/** Top-level discriminator for canonical conversation messages in the timeline.
 *  Mirrors the renderer-side `AgentMessage` union MINUS `user` (renderer-only
 *  variant — providers never emit user messages). */
export type CanonicalMsgType =
  | 'reply' | 'note' | 'system' | 'error'
  | 'fold_text' | 'fold_code' | 'fold_markdown' | 'fold_diff';

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
   * Multi-question interactive form. Provider asks renderer to display a
   * picker and resolve with index-aligned answers (or cancellation).
   *
   * First real producer: Claude's AskUserQuestion tool (intercepted via
   * canUseTool — see DECISIONS #57). Copilot elicitation handler emits
   * this too. `id` is provider-minted (Claude uses toolUseID; Copilot
   * mints a uuid), echoed back via resolve_picker IPC.
   *
   * Each prompt is one question with N options. `multiSelect` toggles
   * checkbox vs radio. `inputType` opens a free-text input (the "Other"
   * affordance from AskUserQuestion); undefined disables free-text.
   */
  | {
      type: 'picker_request';
      id: string;
      prompts: Array<{
        question: string;
        header?: string;
        multiSelect: boolean;
        options: Array<{ label: string; description?: string; preview?: string }>;
        inputType?: 'text' | 'number' | 'integer';
        currentValue?: string | string[];
      }>;
    }
  /**
   * Internal: provider asks orchestrator to merge `patch` into the persisted
   * context for this session. Intercepted by `agent-server/index.ts` and NOT
   * forwarded to the main process — providers stay decoupled from disk I/O.
   */
  | { type: 'context_patch'; patch: Partial<PersistedContext> }

  // ── Streaming (incremental reply/fold_text chunks) ───────────────────────
  // `msgId` ties each chunk to the eventual `type: 'message'` finalize event
  // with the same id. Renderer upserts by msgId — stream chunks append to a
  // placeholder entry that the finalize replaces.
  //
  // `streamType` is the renderer-side variant the finalize will land as:
  //   'text'     → reply (assistant markdown reply)
  //   'thinking' → fold_text (reasoning / Copilot thinking)
  // Wire vocabulary stays 'text'|'thinking' for backward-compatibility with
  // the existing stream-event handler; provider semantics map at finalize time.
  | { type: 'stream'; msgId: string; streamType: 'text' | 'thinking'; content: string }

  // ── Plan side-channel ────────────────────────────────────────────────────
  // Plan is a STATE UPDATE ("current plan = X"), not a timeline entry. Top-
  // level `type: 'plan'` (no msgType envelope) — main forwards to renderer
  // over its own IPC channel; consumer is `agentTabStore.currentPlan`, never
  // the message timeline.
  | { type: 'plan'; content: string }

  // ── Canonical conversation messages ──────────────────────────────────────
  // Renderer-facing variants. Discriminated by `msgType`. Each variant only
  // carries fields it actually needs (see .agent/features/agent-message-type-refactor.md
  // for design rationale).
  //
  // `msgId` is the upsert key in the renderer's message store. For fold_*
  // tool messages, providers typically use the SDK-provided toolUseId as
  // msgId so a pending → completed upsert flows naturally; permission_request
  // still pairs separately via its own toolUseId field.
  //
  // `user` is NOT a wire msgType — `user` messages are renderer-only, minted
  // when the user types into the input. Reflecting that on the wire keeps
  // the agent-server → renderer contract honest about provider authorship.
  | { type: 'message'; msgId: string; msgType: 'reply';   content: string }
  | { type: 'message'; msgId: string; msgType: 'note';    content: string }
  | { type: 'message'; msgId: string; msgType: 'system';  content: string }
  | { type: 'message'; msgId: string; msgType: 'error';   content: string }
  | {
      type: 'message'; msgId: string; msgType: 'fold_text';
      label: string; subtitle?: string; errorMessage?: string;
      body?: { content: string; tone?: 'muted' };
    }
  | {
      type: 'message'; msgId: string; msgType: 'fold_code';
      label: string; subtitle?: string; errorMessage?: string;
      body?: { content: string };
    }
  | {
      type: 'message'; msgId: string; msgType: 'fold_markdown';
      label: string; subtitle?: string; errorMessage?: string;
      body?: { content: string };
    }
  | {
      type: 'message'; msgId: string; msgType: 'fold_diff';
      label: string; subtitle?: string; errorMessage?: string;
      body?: { diff: { oldString: string; newString: string } };
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
   * Structured config edit (from a picker / status-bar click). When set, the
   * provider applies it (set current value + emit capabilities + emit a
   * `system` divider) and returns WITHOUT running an SDK query — `prompt` is
   * empty for these turns. Converges UI config edits onto the same provider
   * path as a typed `/model` slash, so the divider + capabilities come back
   * identically regardless of entry point.
   */
  configEdit?: { key: 'model' | 'effort' | 'permissionMode'; value: string };
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
  /**
   * Set true by a provider's gatherCapabilities when its tab-open auth probe
   * (e.g. Claude's ensureInit SDK init) determined the remote has no valid
   * credentials. Drives the renderer's AuthPane takeover. Undefined/false =
   * authed or unknown (we never block the pane on "unknown").
   */
  authRequired?: boolean;
}

export interface ServerBackend {
  query(input: QueryInput, send: SendFn): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
  /**
   * `intent` carries the renderer's saved prefs (projectConfig.agentPrefs) so
   * providers that track session-level state (Copilot's currentPermissionMode,
   * currentModel, currentEffort closures) can seed them BEFORE building caps —
   * otherwise the first `currentPermissionMode` reported after a reconnect
   * always reflects the provider's hardcoded default instead of the user's
   * saved choice. Providers whose caps don't include `current*` (Claude) can
   * ignore intent; per-call pref hand-off via QueryInput is still authoritative.
   */
  gatherCapabilities?(
    cwd: string,
    sessionId?: string,
    customModels?: ProviderModel[],
    intent?: { model?: string; effort?: string; permissionMode?: string },
  ): Promise<ProviderCapabilities>;
  resolvePermission?(toolUseId: string, allow: boolean, message?: string, scope?: 'once' | 'session'): void;
  /**
   * Resolve a pending picker_request by id. `payload` carries index-aligned
   * answers (one per prompt, multi-select uses string[]) or `cancelled: true`
   * (user pressed Cancel / Esc, or the turn aborted). Provider's internal
   * Promise for that picker resolves with this.
   */
  resolvePicker?(id: string, payload: PickerResolvePayload): void;

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
