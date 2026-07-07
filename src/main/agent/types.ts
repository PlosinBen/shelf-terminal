import type { AgentMessage, AuthMethod, ProviderModel } from '@shared/types';

export type { AgentMessage, AgentMessageType } from '@shared/types';

/**
 * Renderer → main response to a picker_request. Mirrors
 * `agent-server/providers/types.ts` PickerResolvePayload. Kept duplicated
 * here so the main process doesn't depend on agent-server's type module.
 */
export type PickerResolvePayload =
  | { answers: Array<string | string[]> }
  | { cancelled: true };

export type AgentSessionState = 'idle' | 'streaming' | 'waiting_permission' | 'error';

export interface CycleOption {
  value: string;
  displayName: string;
  severity?: StatusSegmentSeverity;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow: number;
  vision: boolean;
  effortLevels?: CycleOption[];
}

export interface SlashCommand {
  name: string;
  description: string;
}

export interface AgentStreamDelta {
  /**
   * Same id as the eventual finalize message — renderer upserts both into
   * a single timeline entry. Stream chunks accumulate delta content under
   * this msgId; the finalize message replaces the accumulated content with
   * the assembled block.
   */
  msgId: string;
  type: 'text' | 'thinking';
  content: string;
}

export type StatusSegmentSeverity = 'normal' | 'warning' | 'critical';

/**
 * A pre-formatted status bar segment. Backend decides label, format, severity.
 * Renderer maps severity to color and emits the text as-is.
 */
export interface StatusSegment {
  text: string;
  severity?: StatusSegmentSeverity;
}

export interface AgentStatusPayload {
  state: AgentSessionState;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  sessionId?: string;
  contextUsage?: StatusSegment;
  rateLimits?: StatusSegment[];
}

export interface ProviderCapabilities {
  models: { value: string; displayName: string; effortLevels?: CycleOption[]; vision?: boolean }[];
  permissionModes: CycleOption[];
  effortLevels: CycleOption[];
  slashCommands: SlashCommand[];
  authMethod?: AuthMethod;
  currentModel?: string;
  currentEffort?: string;
  currentPermissionMode?: string;
  /** True when the provider's tab-open auth probe found no valid credentials. */
  authRequired?: boolean;
}

export type PermissionScope = 'once' | 'session';
export type PermissionResult =
  | { behavior: 'allow'; scope?: PermissionScope }
  | { behavior: 'deny'; message?: string };
export type PermissionCallback = (toolUseId: string, toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;

export interface AgentQueryOptions {
  resume?: string;
  permissionMode?: string;
  canUseTool?: PermissionCallback;
  images?: string[];
  /**
   * Per-send pref values. Renderer is the authoritative owner of these
   * (savedPrefs in projectConfig); main passes them straight through from
   * the AGENT_SEND payload. remote.ts forwards them to agent-server in the
   * send line; orchestrator there diff-detects against last-applied prefs
   * for the session and calls provider.setModel / setEffort etc on change.
   */
  model?: string;
  effort?: string;
  /**
   * Structured config edit (picker / status-bar click). Routed as a no-prompt
   * turn so the provider applies it + emits a divider the same way a typed
   * /model slash does. Threaded through to agent-server's send line.
   */
  configEdit?: { key: 'model' | 'effort' | 'permissionMode'; value: string };
  /**
   * Renderer-minted correlation key for this send. Forwarded to agent-server in
   * the send line so the server's queue snapshot can echo it back. See
   * message-queue-ownership design.
   */
  clientMsgId?: string;
}

export type AgentEvent =
  | { type: 'message'; payload: AgentMessage }
  | { type: 'stream'; payload: AgentStreamDelta }
  | { type: 'status'; payload: AgentStatusPayload }
  /**
   * Plan side-channel — agent's current TodoWrite / ExitPlanMode plan.
   * State update ("current plan = content"), not a timeline entry.
   * Routed via IPC.AGENT_PLAN, lands in agentTabStore.currentPlan.
   */
  | { type: 'plan'; content: string }
  /**
   * Mid-turn capabilities update — e.g. /model slash changing currentModel, or
   * the provider promoting a resolved model. Unlike the initial capabilities
   * (a requestId-keyed RPC response), these arrive on the turn stream and must
   * be forwarded to the renderer's status bar. Without this variant they'd be
   * dropped by parseRemoteMessage and the status bar would never reflect a
   * mid-session model/effort/permission change.
   */
  | { type: 'capabilities'; caps: ProviderCapabilities }
  | { type: 'permission_request'; toolUseId: string; toolName: string; input: Record<string, unknown> }
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
  | { type: 'auth_required'; provider: string }
  /**
   * Interactive device-flow login events (session-level, turnId-less). The
   * prompt carries the verification URL + user code so main can open the LOCAL
   * browser (essential when the agent-server runs on a remote host). `done`
   * reports the terminal outcome. See features copilot-device-login.
   */
  | { type: 'auth_login_prompt'; provider: string; verificationUri: string; userCode: string; prefilledUri: string }
  | { type: 'auth_login_done'; provider: string; ok: boolean; cancelled?: boolean; error?: string }
  | { type: 'error'; error: string };

export interface AgentBackend {
  query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent>;
  stop(): Promise<void>;
  dispose(): void;
  /**
   * Re-run the provider's auth probe and report whether credentials are now
   * valid. `cwd` is required because the probe spins up (or reuses) the remote
   * agent-server, which needs a working directory. Drives the AuthPane Retry
   * button: true clears the pane, false keeps it.
   */
  checkAuth(cwd: string): Promise<boolean>;
  /**
   * `intent` carries renderer's saved prefs (projectConfig.agentPrefs[provider]).
   * Forwarded to agent-server so providers with session-level state (Copilot)
   * can seed currentModel / currentEffort / currentPermissionMode BEFORE
   * reporting `current*` back, so the status bar after reconnect reflects
   * the user's saved choice instead of the provider's hardcoded default.
   */
  getCapabilities?(
    cwd: string,
    customModels?: ProviderModel[],
    intent?: { model?: string; effort?: string; permissionMode?: string },
  ): Promise<ProviderCapabilities>;
  storeCredential?(key: string): Promise<void>;
  clearCredential?(): Promise<void>;
  /**
   * Start an interactive OAuth device-flow login (fire-and-forget). Forwards the
   * command to agent-server; the resulting `auth_login_prompt` / `auth_login_done`
   * events flow back over the session-level sink. Only providers with a CLI
   * device flow (Copilot) implement it. See features copilot-device-login.
   */
  startLogin?(cwd: string): void;
  /** Cancel a running interactive login (fire-and-forget). */
  cancelLogin?(): void;
  clearContext?(): void;
  /**
   * Read a background task's full output from its remote `output_file`. The
   * read happens on the agent-server (on the remote), so main/renderer never
   * touch the remote fs. Rejects if the task is unknown or the file is gone.
   */
  readTaskOutput?(taskId: string): Promise<string>;
  /** Stop a running background task (fire-and-forget; the 'stopped'
   *  task_notification flows back via the task_event lane). See background-tasks#3. */
  stopTask?(taskId: string): Promise<void>;
  /** Cancel a not-yet-running queued message by clientMsgId (fire-and-forget).
   *  Server drops it from its queue + re-emits the queue snapshot. No-op once
   *  running. See message-queue-ownership design. */
  cancelQueued?(clientMsgId: string): void;
  /**
   * Resolve a pending picker_request by forwarding the user's answers (or
   * cancellation) to the remote agent-server. Provider tracks the pending
   * Promise by id and unblocks its in-flight tool / elicitation handler.
   */
  resolvePicker?(pickerId: string, payload: PickerResolvePayload): void;
  /** Tell the live agent-server session to re-scan its app-skill dir so an
   *  app-level skill edit takes effect without reconnect (fire-and-forget).
   *  No-op when there's no live process. See DECISIONS (skill live reload). */
  reloadSkills?(): void;
}
