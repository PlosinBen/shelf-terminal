export type OutgoingMessage = {
  type: 'message' | 'stream' | 'status' | 'error' | 'pong' | 'ready' | 'capabilities' | 'auth_required' | 'permission_request'
    | 'credential_stored' | 'credential_cleared' | 'slash_result';
  [key: string]: unknown;
};

export type SlashResult =
  | { type: 'show-model-picker'; models: { value: string; displayName: string; effortLevels?: string[]; vision?: boolean }[]; current: string }
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
}

export interface ProviderCapabilities {
  models: { value: string; displayName: string; effortLevels?: string[]; vision?: boolean }[];
  permissionModes: string[];
  effortLevels: string[];
  slashCommands: { name: string; description: string }[];
  authMethod?: unknown;
}

export interface ServerBackend {
  query(input: QueryInput, send: SendFn): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
  gatherCapabilities?(cwd: string, sessionId?: string): Promise<ProviderCapabilities>;
  resolvePermission?(toolUseId: string, allow: boolean, message?: string): void;
  storeCredential?(key: string): Promise<void>;
  clearCredential?(): Promise<void>;
  handleSlashCommand?(cmd: string, args: string): Promise<SlashResult>;
}
