/** Shelf-owned endpoint/bootstrap contract; no provider or crypto implementation. */
export const SHELF_MCP = {
  HOST: '127.0.0.1',
  PATH: '/mcp',
  AUTHORIZE: 'shelf_mcp.authorize',
  SIGNING_DOMAIN: 'shelf.mcp.endpoint.v1',
} as const;

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
