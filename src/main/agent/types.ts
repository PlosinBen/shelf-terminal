import type { AgentProvider } from '@shared/types';

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
  models: { value: string; displayName: string; effortLevels?: string[] }[];
  permissionModes: string[];
  effortLevels: string[];
  slashCommands: { name: string; description: string }[];
  currentModel?: string;
  currentEffort?: string;
  currentPermissionMode?: string;
}

export interface AgentBackend {
  query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent>;
  stop(): Promise<void>;
  dispose(): void;
  warmup?(cwd: string): Promise<ProviderCapabilities | null>;
  checkAuth?(): Promise<boolean>;
  getSlashCommands?(): Promise<{ name: string; description: string }[]>;
  setModel?(model: string): void;
  setEffort?(effort: string): void;
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
