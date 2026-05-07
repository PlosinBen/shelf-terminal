import type { AuthMethod, ProviderModel } from '@shared/types';

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

export type SlashResult =
  | { type: 'show-model-picker'; models: { value: string; displayName: string; effortLevels?: CycleOption[]; vision?: boolean }[]; current: string }
  | { type: 'switch-model'; model: string }
  | { type: 'context-cleared'; message?: string }
  | { type: 'pass-through' }
  | { type: 'system-message'; content: string }
  | { type: 'error'; message: string };

export interface AgentBackend {
  query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent>;
  stop(): Promise<void>;
  dispose(): void;
  checkAuth(): Promise<boolean>;
  getCapabilities?(cwd: string, customModels?: ProviderModel[]): Promise<ProviderCapabilities>;
  setModel?(model: string): void;
  setEffort?(effort: string): void;
  setPermissionMode?(mode: string): void;
  storeCredential?(key: string): Promise<void>;
  clearCredential?(): Promise<void>;
  clearContext?(): void;
  handleSlashCommand?(cmd: string, args: string, cwd?: string): Promise<SlashResult>;
}
