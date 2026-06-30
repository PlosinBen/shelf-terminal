import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { log } from '@shared/logger';
import type { McpServerBlock, McpServersFile, McpStoreResult } from '@shared/mcp';
import { isValidMcpServerName, validateMcpServerBlock, validateMcpEntry } from '@shared/mcp';

// Re-export the pure validators (defined in @shared/mcp so the agent-server can
// reuse them without pulling electron) for existing import sites / tests.
export { isValidMcpServerName, validateMcpServerBlock, validateMcpEntry };

/**
 * App-level MCP server config store. Source of truth = a single JSON file
 * `<userData>/mcp-servers.json` holding a keyed object `{ "<name>": <block> }`.
 * Modelled on web-grants.ts (single small JSON, synchronous read/write) rather
 * than skills-store.ts (per-skill folders).
 *
 * The config is stored OPAQUE: `env`/`headers` may hold literal tokens or `${VAR}`
 * references — Shelf writes them verbatim and takes no secret custody (see
 * features/app-level-mcps secret/auth decision). `${VAR}` resolution happens in
 * the agent-server at session-create, never here.
 */

function configPath(): string {
  return path.join(app.getPath('userData'), 'mcp-servers.json');
}

/** Read the full keyed object (only valid entries). Missing file = empty. A
 *  corrupt file is logged loud and treated as empty (fail-loud, don't crash). */
export function listMcpServers(): McpServersFile {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.error('mcp', `failed to read ${configPath()}`, err);
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error('mcp', 'mcp-servers.json is not valid JSON — treating as empty', err);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.error('mcp', 'mcp-servers.json is not a keyed object — treating as empty');
    return {};
  }
  const out: McpServersFile = {};
  for (const [name, block] of Object.entries(parsed as Record<string, unknown>)) {
    if (validateMcpEntry(name, block) === null) out[name] = block as McpServerBlock;
  }
  return out;
}

export function getMcpServer(name: string): McpServerBlock | null {
  return listMcpServers()[name] ?? null;
}

function writeAll(servers: McpServersFile): void {
  // Stable key order (sorted) for clean git diffs under config-sync.
  const sorted: McpServersFile = {};
  for (const name of Object.keys(servers).sort()) sorted[name] = servers[name];
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(sorted, null, 2) + '\n', 'utf-8');
}

/** Add a new server. Errors on an invalid name/shape or a name collision. */
export function addMcpServer(name: string, block: McpServerBlock): McpStoreResult {
  const error = validateMcpEntry(name, block);
  if (error) return { ok: false, error };
  const current = listMcpServers();
  if (name in current) return { ok: false, error: `A server named "${name}" already exists` };
  writeAll({ ...current, [name]: block });
  return { ok: true, name };
}

/**
 * Replace the server `name` with `block`. If `nextName` is given and differs, the
 * entry is renamed (collision-checked). Errors if `name` doesn't exist or the new
 * name/shape is bad.
 */
export function updateMcpServer(name: string, block: McpServerBlock, nextName?: string): McpStoreResult {
  const finalName = nextName ?? name;
  const error = validateMcpEntry(finalName, block);
  if (error) return { ok: false, error };
  const current = listMcpServers();
  if (!(name in current)) return { ok: false, error: `Server not found: ${name}` };
  if (finalName !== name && finalName in current) {
    return { ok: false, error: `A server named "${finalName}" already exists` };
  }
  const next: McpServersFile = { ...current };
  delete next[name];
  next[finalName] = block;
  writeAll(next);
  return { ok: true, name: finalName };
}

export function removeMcpServer(name: string): void {
  const current = listMcpServers();
  if (name in current) {
    delete current[name];
    writeAll(current);
  }
}
