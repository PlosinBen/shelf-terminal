/**
 * App-level MCP server config — user-provided external MCP servers, set once and
 * applied across all projects and both agents (Claude / Copilot), running on the
 * worker. Sister to app-level skills. See features/app-level-mcps.
 *
 * Storage is a single `<userData>/mcp-servers.json` holding a `McpServerConfig[]`
 * (name = unique key — the SDK `mcpServers` record is keyed by name). The config
 * is persisted OPAQUE: a token in `env`/`headers` is the user's choice (same as a
 * project init-script that may `export API_KEY=…`), Shelf takes no custody. Secret
 * governance lives at the config-sync egress boundary, not here.
 *
 * Only two user-facing transports. The SDK's `sdk`-type server is the internal
 * `shelf` bridge and is never user-authored, so it has no schema here.
 */

export type McpTransport = 'stdio' | 'http';

export interface McpStdioServer {
  type: 'stdio';
  /** Unique key (also the SDK `mcpServers` record key). */
  name: string;
  command: string;
  args?: string[];
  /** Env passed to the spawned server. Values MAY be `${VAR}` references resolved
   *  against the worker env at session-create (recommended over literals so a
   *  synced file carries no secret). Shelf stores them verbatim. */
  env?: Record<string, string>;
}

export interface McpHttpServer {
  type: 'http';
  name: string;
  url: string;
  /** Auth headers (e.g. `Authorization: Bearer …`). Same `${VAR}` recommendation
   *  as stdio `env`. */
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

/** Result of a store mutation (mirrors SkillUpdateResult). */
export interface McpStoreResult {
  ok: boolean;
  /** The (possibly renamed) server name on success. */
  name?: string;
  error?: string;
}

// ── Pure validators (no electron / fs) — shared by the main store and the
// agent-server loader so both ends agree on what a valid server is. ──

/** Valid server name: non-empty, no path/space chars. Used as the SDK record
 *  key, so it must be a clean identifier — but NOT forced to kebab (MCP names
 *  aren't paths, e.g. `github`, `my_server`). */
export function isValidMcpServerName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function isStringMap(v: unknown): boolean {
  if (v === undefined) return true;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

/** Validate a server config shape. Returns an error string, or null when valid.
 *  Env/header VALUES are opaque (may be secrets or `${VAR}`), so they're not
 *  inspected beyond being strings. */
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
