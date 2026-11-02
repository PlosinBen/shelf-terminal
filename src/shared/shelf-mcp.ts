/** Shelf-owned endpoint/bootstrap contract; no provider or crypto implementation. */
export const SHELF_MCP = {
  HOST: '127.0.0.1',
  PATH: '/mcp',
  AUTHORIZE: 'shelf_mcp.authorize',
  SIGNING_DOMAIN: 'shelf.mcp.endpoint.v1',
  STATUS: 'shelf_mcp_status',
  STATUS_EVENT: 'agent:onShelfMcpStatus',
} as const;

export const SHELF_MCP_STATE = { AVAILABLE: 'available', UNAVAILABLE: 'unavailable' } as const;
export const SHELF_MCP_FAILURE = { AUTHORIZATION: 'authorization', LISTENER: 'listener', STARTUP: 'startup' } as const;
export type ShelfMcpFailure = typeof SHELF_MCP_FAILURE[keyof typeof SHELF_MCP_FAILURE];
export type ShelfMcpStatus =
  | { state: typeof SHELF_MCP_STATE.AVAILABLE }
  | { state: typeof SHELF_MCP_STATE.UNAVAILABLE; reason: ShelfMcpFailure };

/** Parse only public status fields; never forward bootstrap material to UI. */
export function parseShelfMcpStatus(value: unknown): ShelfMcpStatus {
  const status = value as Partial<{ state: string; reason: ShelfMcpFailure }> | null;
  if (status?.state === SHELF_MCP_STATE.AVAILABLE) return { state: SHELF_MCP_STATE.AVAILABLE };
  if (status?.state === SHELF_MCP_STATE.UNAVAILABLE
    && Object.values(SHELF_MCP_FAILURE).includes(status.reason!)) {
    return { state: SHELF_MCP_STATE.UNAVAILABLE, reason: status.reason! };
  }
  throw new Error('Invalid Shelf MCP startup status');
}

export interface ShelfMcpEndpoint {
  url: string;
  headers?: Readonly<Record<string, string>>;
}

export interface ShelfMcpAuthorization {
  projectId: string;
  agentSessionId: string;
  endpointId: string;
  /** SPKI PEM public key; the private key never crosses the main boundary. */
  publicKey: string;
  /** Base64url Ed25519 signature over the endpoint's known authorization scope. */
  token: string;
}

export function isShelfMcpEndpointId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function shelfMcpSigningPayload(projectId: string, agentSessionId: string, endpointId: string): string {
  return JSON.stringify([SHELF_MCP.SIGNING_DOMAIN, projectId, agentSessionId, endpointId]);
}
