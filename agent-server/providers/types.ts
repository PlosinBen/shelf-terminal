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

export type OutgoingMessage = {
  type: 'message' | 'stream' | 'status' | 'error' | 'pong' | 'ready' | 'capabilities' | 'auth_required' | 'permission_request'
    | 'credential_stored' | 'credential_cleared' | 'slash_result';
  [key: string]: unknown;
};

export type SlashResult =
  | { type: 'show-model-picker'; models: { value: string; displayName: string; effortLevels?: CycleOption[]; vision?: boolean }[]; current: string }
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

/**
 * A cycle-able option in the status bar (mode / effort).
 * Provider decides displayName + severity; renderer cycles by `value`.
 */
export interface CycleOption {
  value: string;
  displayName: string;
  severity?: StatusSegmentSeverity;
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
  gatherCapabilities?(cwd: string, sessionId?: string): Promise<ProviderCapabilities>;
  resolvePermission?(toolUseId: string, allow: boolean, message?: string): void;
  storeCredential?(key: string): Promise<void>;
  clearCredential?(): Promise<void>;
  handleSlashCommand?(cmd: string, args: string): Promise<SlashResult>;
}
