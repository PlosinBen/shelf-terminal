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
