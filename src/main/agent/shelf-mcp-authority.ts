import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { isShelfMcpEndpointId, shelfMcpSigningPayload, type ShelfMcpAuthorization } from '@shared/shelf-mcp';

/** mcp#13: one in-memory signing identity per Project, owned only by main. */
export function createShelfMcpAuthority() {
  const projects = new Map<string, { publicKey: KeyObject; privateKey: KeyObject }>();
  return {
    authorize(projectId: string, agentSessionId: string, endpointId: string): ShelfMcpAuthorization {
      if (!projectId || !agentSessionId || !isShelfMcpEndpointId(endpointId)) throw new Error('Invalid Shelf MCP authorization scope');
      let keys = projects.get(projectId);
      if (!keys) {
        keys = generateKeyPairSync('ed25519');
        projects.set(projectId, keys);
      }
      return {
        projectId,
        agentSessionId,
        endpointId,
        publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        token: sign(null, Buffer.from(shelfMcpSigningPayload(projectId, agentSessionId, endpointId)), keys.privateKey).toString('base64url'),
      };
    },
  };
}

// Module lifetime is the App main process lifetime; nothing is persisted.
export const shelfMcpAuthority = createShelfMcpAuthority();
