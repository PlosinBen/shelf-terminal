import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { log } from '@shared/logger';
import type { McpServerConfig, McpStoreResult } from '@shared/mcp';
import { isValidMcpServerName, validateMcpServer } from '@shared/mcp';

// Re-export the pure validators (defined in @shared/mcp so the agent-server can
// reuse them without pulling electron) for existing import sites / tests.
export { isValidMcpServerName, validateMcpServer };

/**
 * App-level MCP server config store. Source of truth = a single JSON file
 * `<userData>/mcp-servers.json` holding a `McpServerConfig[]`. Modelled on
 * web-grants.ts (single small JSON, synchronous read/write) rather than
 * skills-store.ts (per-skill folders) — there is no per-server filesystem layout
 * to manage, so the folder ceremony would be overkill.
 *
 * The config is stored OPAQUE: `env`/`headers` may hold literal tokens or `${VAR}`
 * references — Shelf writes them verbatim and takes no secret custody (see
 * features/app-level-mcps secret/auth decision). `${VAR}` resolution happens in
 * the agent-server at session-create, never here.
 */

function configPath(): string {
  return path.join(app.getPath('userData'), 'mcp-servers.json');
}

/** Read the full list (sorted by name). Missing file = no servers yet. A corrupt
 *  file is logged loud and treated as empty (fail-loud, don't crash the app). */
export function listMcpServers(): McpServerConfig[] {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.error('mcp', `failed to read ${configPath()}`, err);
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error('mcp', `mcp-servers.json is not valid JSON — treating as empty`, err);
    return [];
  }
  if (!Array.isArray(parsed)) {
    log.error('mcp', 'mcp-servers.json is not an array — treating as empty');
    return [];
  }
  const out = parsed.filter((c): c is McpServerConfig => validateMcpServer(c) === null);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function getMcpServer(name: string): McpServerConfig | null {
  return listMcpServers().find((s) => s.name === name) ?? null;
}

function writeAll(servers: McpServerConfig[]): void {
  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(sorted, null, 2) + '\n', 'utf-8');
}

/** Add a new server. Errors on an invalid shape or a name collision. */
export function addMcpServer(cfg: McpServerConfig): McpStoreResult {
  const error = validateMcpServer(cfg);
  if (error) return { ok: false, error };
  const current = listMcpServers();
  if (current.some((s) => s.name === cfg.name)) {
    return { ok: false, error: `A server named "${cfg.name}" already exists` };
  }
  writeAll([...current, cfg]);
  return { ok: true, name: cfg.name };
}

/** Replace the server at `name` with `cfg` (whose name may differ → rename, with
 *  a collision check). Errors if `name` doesn't exist or the new shape/name is
 *  bad. */
export function updateMcpServer(name: string, cfg: McpServerConfig): McpStoreResult {
  const error = validateMcpServer(cfg);
  if (error) return { ok: false, error };
  const current = listMcpServers();
  const idx = current.findIndex((s) => s.name === name);
  if (idx === -1) return { ok: false, error: `Server not found: ${name}` };
  if (cfg.name !== name && current.some((s) => s.name === cfg.name)) {
    return { ok: false, error: `A server named "${cfg.name}" already exists` };
  }
  const next = [...current];
  next[idx] = cfg;
  writeAll(next);
  return { ok: true, name: cfg.name };
}

export function removeMcpServer(name: string): void {
  const current = listMcpServers();
  const next = current.filter((s) => s.name !== name);
  if (next.length !== current.length) writeAll(next);
}
