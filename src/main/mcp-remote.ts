import fs from 'fs';
import type { Connection } from '@shared/types';
import { log } from '@shared/logger';
import { transportPut } from './connector/transport';
import { mcpConfigSourcePath, hashMcpConfig } from './mcp-projection';
import { getAppInstanceId } from './app-instance-id';

/**
 * Re-mirror the app-level MCP config onto ONE remote connection through the
 * type-declared transport (features/app-level-mcps "Transport primitive"). The
 * client declares `type: 'mcp'` + `appId`; the transport resolves the worker path
 * and places the bytes. Two callers:
 *   - the deploy path (connect time) — so a fresh remote session loads MCP;
 *   - the onMcpChanged subscriber (edit time) — re-mirror to live remotes.
 *
 * Local is a no-op: onMcpChanged re-projects to the local consumption path.
 *
 * Client-side hash-gate (not the remote `.synced` sentinel skills use): a tiny
 * single file makes a redundant push cheap, and an in-memory gate avoids an
 * unverifiable remote read. Worst case after a client restart is one redundant
 * push. No heartbeat touch — when we sync, the agent-server on that worker is
 * either being deployed (its spawn establishes the lease) or already live
 * (holding it). See the v1 decision.
 */

const lastSyncHash = new Map<string, string>();

export async function syncMcpForConnection(connection: Connection): Promise<void> {
  if (connection.type === 'local') return;
  const src = mcpConfigSourcePath();
  if (!fs.existsSync(src)) return; // user configured no servers → nothing to place
  const key = JSON.stringify(connection);
  const hash = hashMcpConfig(src);
  if (lastSyncHash.get(key) === hash) return; // unchanged since this connection's last sync
  await transportPut(connection, {
    type: 'mcp',
    context: { appId: getAppInstanceId() },
    source: { localPath: src },
  });
  lastSyncHash.set(key, hash);
  log.info('mcp', `synced MCP config to ${connection.type}`);
}

/** Test seam: clear the client-side sync gate. */
export function __resetMcpSyncGate(): void {
  lastSyncHash.clear();
}
