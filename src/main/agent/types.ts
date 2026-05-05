import type { AuthMethod } from '@shared/types';

export type AgentSessionState = 'idle' | 'streaming' | 'waiting_permission' | 'error';

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow: number;
  vision: boolean;
  effortLevels?: string[];
}

export interface SlashCommand {
  name: string;
  description: string;
}

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

export interface AgentStatusPayload {
  state: AgentSessionState;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  sessionId?: string;
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

export type PermissionResult = { behavior: 'allow' } | { behavior: 'deny'; message?: string };
export type PermissionCallback = (toolUseId: string, toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;

export interface AgentQueryOptions {
  resume?: string;
  permissionMode?: string;
  canUseTool?: PermissionCallback;
  images?: string[];
}

export type AgentEvent =
  | { type: 'message'; payload: AgentMessagePayload }
  | { type: 'stream'; payload: AgentStreamDelta }
  | { type: 'status'; payload: AgentStatusPayload }
  | { type: 'permission_request'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'auth_required'; provider: string }
  | { type: 'error'; error: string };

export interface AgentBackend {
  query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent>;
  stop(): Promise<void>;
  dispose(): void;
  checkAuth(): Promise<boolean>;
  getCapabilities?(cwd: string): Promise<ProviderCapabilities>;
  setModel?(model: string): void;
  setEffort?(effort: string): void;
  setPermissionMode?(mode: string): void;
  storeCredential?(key: string): Promise<void>;
  clearCredential?(): Promise<void>;
  clearContext?(): void;
}
