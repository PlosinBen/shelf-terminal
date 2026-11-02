import { createPublicKey, verify } from 'node:crypto';
import { SHELF_MCP, shelfMcpSigningPayload, type ShelfMcpAuthorization } from '@shared/shelf-mcp';
import { callMain } from './app-tool-client';

export interface ShelfMcpAuthentication {
  readonly headers: Readonly<Record<string, string>>;
  verifyAuthorization(value: string | string[] | undefined): boolean;
}

/** Trust material arrives only over the existing main↔exec channel, never HTTP.
 * The HTTP client supplies only a signature, not a key, algorithm, or scope. */
export function createShelfMcpAuthentication(authorization: ShelfMcpAuthorization, endpointId: string): ShelfMcpAuthentication {
  if (!authorization || typeof authorization.projectId !== 'string' || !authorization.projectId
    || typeof authorization.agentSessionId !== 'string' || !authorization.agentSessionId
    || authorization.endpointId !== endpointId || typeof authorization.publicKey !== 'string'
    || typeof authorization.token !== 'string') throw new Error('Invalid Shelf MCP authorization response');
  const key = createPublicKey(authorization.publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Shelf MCP requires an Ed25519 public key');
  const payload = Buffer.from(shelfMcpSigningPayload(authorization.projectId, authorization.agentSessionId, endpointId));
  const verifyToken = (token: string): boolean => {
    // Ed25519 signatures are 64 bytes. Reject non-canonical encodings before
    // verify (Buffer's base64 decoder otherwise tolerates malformed input).
    if (!/^[A-Za-z0-9_-]{86}$/.test(token)) return false;
    const signature = Buffer.from(token, 'base64url');
    return signature.toString('base64url') === token && verify(null, payload, key, signature);
  };
  if (!verifyToken(authorization.token)) throw new Error('Shelf MCP bootstrap signature verification failed');
  return {
    headers: Object.freeze({ Authorization: `Bearer ${authorization.token}` }),
    verifyAuthorization(value) {
      return typeof value === 'string' && value.startsWith('Bearer ') && verifyToken(value.slice(7));
    },
  };
}

/** Bounded bootstrap; never fall back to an unauthenticated listener. */
export async function requestShelfMcpAuthentication(endpointId: string, timeoutMs = 10_000): Promise<ShelfMcpAuthentication> {
  // The nonce also prevents a late reply to an old exec's at-1 from satisfying
  // this exec's first request after dispatcher reconnect.
  const result = await callMain(SHELF_MCP.AUTHORIZE, { endpointId }, {
    requestId: `at-auth-${endpointId}`, timeoutMs,
  });
  if (!result.ok) throw new Error(`Shelf MCP authorization failed: ${result.error ?? 'main rejected bootstrap'}`);
  return createShelfMcpAuthentication(result.data as ShelfMcpAuthorization, endpointId);
}
