export type OutgoingMessage = {
  type: 'message' | 'stream' | 'status' | 'error' | 'pong' | 'ready' | 'capabilities' | 'auth_required' | 'permission_request';
  [key: string]: unknown;
};

export type SendFn = (msg: OutgoingMessage) => void;

export interface QueryInput {
  prompt: string;
  cwd: string;
  resume?: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
  images?: string[];
}

/** Minimal server-side backend interface — mirrors src/main/agent/types.ts's
 * AgentBackend but without provider wrapper concerns (auth UI lives on main). */
export interface ServerBackend {
  query(input: QueryInput, send: SendFn): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
  /** Compose ProviderCapabilities in a single call, so main only needs one
   * round-trip when initialising a remote agent tab. */
  gatherCapabilities?(cwd: string): Promise<import('../../src/main/agent/types').ProviderCapabilities>;
  /** Called when main sends a resolve_permission message — used by backends
   * whose query pipelines emit permission_request events. */
  resolvePermission?(toolUseId: string, allow: boolean, message?: string): void;
  /** For api-key providers: persist a credential on the target machine. */
  storeCredential?(key: string): Promise<void>;
  /** Wipe the stored credential on the target machine. */
  clearCredential?(): Promise<void>;
}
