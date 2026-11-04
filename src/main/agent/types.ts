import type { AgentMessage, AgentPrefs, AuthMethod, ProviderModel } from '@shared/types';
import type { AgentInputRequest } from '@shared/agent-input';
import type { PermissionControlCapabilities } from '@shared/permission-controls';
import { SHELF_MCP, type ShelfMcpStatus } from '@shared/shelf-mcp';

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
  description?: string;
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
  /** OPTIONAL: a pure account-status refresh (credits) omits it so the renderer
   *  doesn't run streaming/execution-end side effects for a non-execution update. */
  state?: AgentSessionState;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  sessionId?: string;
  /** `null` explicitly clears usage from a replaced conversation session. */
  contextUsage?: StatusSegment | null;
  rateLimits?: StatusSegment[];
  /** Account-level usage (copilot premium-request quota, session-scoped delivery). */
  credits?: StatusSegment;
}

export interface ProviderCapabilities {
  /** When present, only this explicit confirmed intent is persisted. Empty means display only. */
  confirmedPrefs?: Partial<import('@shared/types').AgentPrefs>;
  models: { value: string; displayName: string; effortLevels?: CycleOption[]; vision?: boolean }[];
  permissionModes: CycleOption[];
  permissionControl: PermissionControlCapabilities;
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
  /** Existing optimistic queue projection; omitted when the caller mirrors history directly. */
  clientMsgId?: string;
  resume?: string;
  canUseTool?: PermissionCallback;
}

export type AgentEvent =
  | { type: typeof SHELF_MCP.STATUS; status: ShelfMcpStatus }
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
   * Mid-execution capabilities update — e.g. /model slash changing currentModel, or
   * the provider promoting a resolved model. Unlike the initial capabilities
   * (a requestId-keyed RPC response), these arrive on the execution stream and must
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
   * Interactive device-flow login events (session-level, executionId-less). The
   * prompt carries the verification URL + user code so main can open the LOCAL
   * browser (essential when the agent-server runs on a remote host). `done`
   * reports the terminal outcome. See features copilot-device-login.
   */
  | { type: 'auth_login_prompt'; provider: string; verificationUri: string; userCode: string; prefilledUri: string }
  | { type: 'auth_login_done'; provider: string; ok: boolean; cancelled?: boolean; error?: string }
  | { type: 'error'; error: string };

export interface AgentBackend {
  query(input: AgentInputRequest, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent>;
  stop(): Promise<void>;
  dispose(): void;
  /**
   * Re-run the provider's auth probe and retain the fresh capabilities so main
   * can publish them before returning the renderer-facing boolean verdict.
   * `null` means the probe itself failed. This query owns its authBusy/authError
   * surface and therefore must not emit init lifecycle phases.
   */
  checkAuth(cwd: string, customModels?: ProviderModel[]): Promise<ProviderCapabilities | null>;
  /**
   * `intent` carries renderer's saved prefs from canonical
   * `Project.agentViews[sessionId].prefs` (`Project` is defined by `@shared/projects`).
   * Forwarded to agent-server before input. Production reads current canonical
   * Project prefs at each initialization; no per-message replay or prefs cache.
   */
  getCapabilities?(
    cwd: string,
    customModels?: ProviderModel[],
    intent?: AgentPrefs,
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
  /**
   * Drop the provider's live ACP connection on the agent-server (fire-and-forget)
   * so the NEXT capabilities probe / execution respawns and re-reads the config-home
   * credentials. Called after a successful device-login (and by the checkAuth
   * Retry path), because an already-running `--acp` process spawned pre-login won't
   * re-read the credentials the login wrote. No-op when there's no live process.
   * See agent-providers#11.
   */
  reconnect?(): void;
}
