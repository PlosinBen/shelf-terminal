import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { app } from 'electron';
import { log } from '@shared/logger';

/**
 * Local projection of the app-level MCP config onto the per-app consumption path
 * the agent-server reads (sibling to skills-projection.ts, see
 * features/app-level-mcps):
 *
 *   <userData>/mcp-servers.json  →  ~/.shelf/apps/<appId>/mcp-servers.json
 *
 * UNLIKE skills (a tree the SDK auto-discovers from a path), the MCP config is an
 * SDK *parameter*: the agent-server READS this file at session-create and feeds
 * `mcpServers`. The projection still exists — and still runs even locally — so the
 * agent-server always reads the same `homedir/.shelf/apps/<appId>/…` path with
 * zero local/remote branching (deployment#1). L3 swaps this fs copy for
 * scp/docker cp/wsl, gated by `hashMcpConfig` (the `.synced` sentinel).
 */

export function mcpConfigSourcePath(): string {
  return path.join(app.getPath('userData'), 'mcp-servers.json');
}

/** The local consumption path for this app instance. */
export function localMcpTarget(appId: string): string {
  return path.join(os.homedir(), '.shelf', 'apps', appId, 'mcp-servers.json');
}

/** Content fingerprint of the MCP config (file bytes). Drives the remote
 *  `.synced` incremental gate — re-sync only when this changes. Empty string when
 *  there's no source. */
export function hashMcpConfig(sourcePath: string): string {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(sourcePath);
  } catch {
    return '';
  }
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Project the MCP config onto `~/.shelf/apps/<appId>/mcp-servers.json` on THIS
 * machine. No-op when there's no source (user has configured no servers). Touches
 * the app's `.heartbeat` lease (shared with skills) so the agent-server startup
 * sweep doesn't reclaim a just-projected dir — a user may have MCP but no skills,
 * in which case the skills projection never runs and nothing else would touch it.
 * Best-effort — never throws into the session-start path.
 */
export function projectMcpLocal(appId: string): void {
  const src = mcpConfigSourcePath();
  const dst = localMcpTarget(appId);
  try {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    fs.writeFileSync(path.join(path.dirname(dst), '.heartbeat'), '');
  } catch (err: any) {
    log.error('mcp', `local projection failed for app ${appId.slice(0, 8)}: ${err?.message ?? err}`);
  }
}
