import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { log } from '@shared/logger';
import type { McpServerConfig, McpStoreResult } from '@shared/mcp';

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

/** Valid server name: non-empty, no path/space chars. Used as the SDK record key,
 *  so it must be a clean identifier — but NOT forced to kebab (MCP names aren't
 *  paths, e.g. `github`, `my_server`). Pure → unit-testable. */
export function isValidMcpServerName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/** Validate a server config shape. Returns an error string, or null when valid.
 *  Pure (no fs) → unit-testable. Env/header VALUES are opaque (may be secrets or
 *  `${VAR}`), so they're not inspected beyond being strings. */
export function validateMcpServer(cfg: unknown): string | null {
  if (!cfg || typeof cfg !== 'object') return 'Server config must be an object';
  const c = cfg as Record<string, unknown>;
  if (!isValidMcpServerName(c.name)) {
    return `Invalid server name (use letters/digits/._-, no spaces): ${String(c.name)}`;
  }
  if (c.type === 'stdio') {
    if (typeof c.command !== 'string' || !c.command.trim()) return 'stdio server needs a `command`';
    if (c.args !== undefined && !(Array.isArray(c.args) && c.args.every((a) => typeof a === 'string'))) {
      return '`args` must be an array of strings';
    }
    if (!isStringMap(c.env)) return '`env` must be a string→string map';
    return null;
  }
  if (c.type === 'http') {
    if (typeof c.url !== 'string' || !c.url.trim()) return 'http server needs a `url`';
    if (!isStringMap(c.headers)) return '`headers` must be a string→string map';
    return null;
  }
  return `Unknown server type: ${String(c.type)} (expected 'stdio' or 'http')`;
}

function isStringMap(v: unknown): boolean {
  if (v === undefined) return true;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
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
