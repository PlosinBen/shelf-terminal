import type { AgentProvider } from '@shared/types';
import type { AuthMethod, ModelInfo, SlashCommand } from './engine/types';

export type { AuthMethod, ModelInfo, SlashCommand } from './engine/types';

export type AgentSessionState = 'idle' | 'streaming' | 'waiting_permission' | 'error';

export interface AgentMessagePayload {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'error';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  parentToolUseId?: string;
  sessionId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentStreamDelta {
  type: 'text' | 'thinking';
  content: string;
}

export interface RateLimitInfo {
  rateLimitType?: string;
  status?: string;
  utilization?: number;
  resetsAt?: number;
}

export interface AgentStatusPayload {
  state: AgentSessionState;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  sessionId?: string;
  rateLimit?: RateLimitInfo;
  contextUsedTokens?: number;
  contextWindow?: number;
}

export interface ProviderCapabilities {
  models: { value: string; displayName: string; effortLevels?: string[]; vision?: boolean }[];
  permissionModes: string[];
  effortLevels: string[];
  slashCommands: SlashCommand[];
  authMethod?: AuthMethod;
  currentModel?: string;
  currentEffort?: string;
  currentPermissionMode?: string;
}

/**
 * Backend interface. The capability getters (getModels / getSlashCommands / …)
 * are the v0.8 method-per-capability surface; main's gatherCapabilities()
 * composes them into a ProviderCapabilities blob. `warmup` is kept temporarily
 * during the migration and will be removed once every provider has migrated.
 */
export interface AgentBackend {
  // Lifecycle
  query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent>;
  stop(): Promise<void>;
  dispose(): void;

  // Required capability probes
  checkAuth(): Promise<boolean>;

  // Capability getters — main's gatherCapabilities composes them into
  // ProviderCapabilities. Still optional on the interface so the remote
  // backend (which only forwards to agent-server) can skip them.
  getModels?(cwd?: string): Promise<ModelInfo[]>;
  getSlashCommands?(): Promise<SlashCommand[]>;
  getPermissionModes?(): string[];
  getEffortLevels?(): string[];
  getAuthMethod?(): AuthMethod;
  /** Single-shot aggregator for remote backends that need one round-trip
   * instead of five individual getter calls. Local backends omit this and
   * let main's gatherCapabilities compose from the getters above. */
  getCapabilities?(cwd: string): Promise<ProviderCapabilities>;

  // Runtime setters
  setModel?(model: string): void;
  setEffort?(effort: string): void;

  // API-key providers only (authMethod.kind === 'api-key')
  storeCredential?(key: string): Promise<void>;
}

export interface AgentQueryOptions {
  resume?: string;
  permissionMode?: string;
  canUseTool?: PermissionCallback;
  /** Base64 data URLs for images attached to the user turn. */
  images?: string[];
}

export type PermissionResult = { behavior: 'allow' } | { behavior: 'deny'; message?: string };
export type PermissionCallback = (toolUseId: string, toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;

export type AgentEvent =
  | { type: 'message'; payload: AgentMessagePayload }
  | { type: 'stream'; payload: AgentStreamDelta }
  | { type: 'status'; payload: AgentStatusPayload }
  | { type: 'permission_request'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'auth_required'; provider: string }
  | { type: 'error'; error: string };
