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
}
