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

export interface AgentStatusPayload {
  state: AgentSessionState;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  sessionId?: string;
}

export interface AgentBackend {
  query(prompt: string, cwd: string, opts?: AgentQueryOptions): AsyncGenerator<AgentEvent>;
  stop(): Promise<void>;
  dispose(): void;
}

export interface AgentQueryOptions {
  resume?: string;
  permissionMode?: string;
  canUseTool?: PermissionCallback;
}

export type PermissionResult = { behavior: 'allow' } | { behavior: 'deny'; message?: string };
export type PermissionCallback = (toolUseId: string, toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;

export type AgentEvent =
  | { type: 'message'; payload: AgentMessagePayload }
  | { type: 'stream'; payload: AgentStreamDelta }
  | { type: 'status'; payload: AgentStatusPayload }
  | { type: 'permission_request'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'error'; error: string };
