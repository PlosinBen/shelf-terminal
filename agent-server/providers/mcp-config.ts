import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { McpServerBlock, McpServersFile } from '@shared/mcp';
import { validateMcpEntry } from '@shared/mcp';
import { shelfPlacement } from '@shared/shelf-paths';

/**
 * Agent-server consumption of the projected app-level MCP config (see
 * features/app-level-mcps). UNLIKE skills (a tree the SDK auto-discovers), the
 * MCP config is an SDK *parameter*: this layer READS + PARSES
 * `~/.shelf/apps/<appId>/mcp-servers.json` at session-create, resolves `${VAR}`
 * references against the worker env, and hands the result to the provider, which
 * shapes it into the SDK `mcpServers` record (and, for Claude, merges it with the
 * in-process `shelf` bridge entry — never clobbering it).
 *
 * Secret handling: env/header values may be literal or `${VAR}` references. This
 * is the ONE place a `${VAR}` is materialised — on the worker, in-memory, at read
 * time; Shelf never persists the resolved value. Fail-loud throughout: a parse
 * error, an unknown server shape, or a `${VAR}` whose variable is absent on the
 * worker is reported (not silently dropped) so a misconfig surfaces instead of a
 * server quietly missing (cf the skills#6 silent-skip lesson).
 */

/** This app's projected MCP config path on THIS machine, or null if absent. The
 *  layout comes from the SHARED `shelfPlacement` rule (same one the transport
 *  uses to place the file) so the write and read sides can't drift. */
export function resolveMcpConfigPath(appId: string | undefined): string | null {
  if (!appId) return null;
  const { rel } = shelfPlacement('mcp', { appId });
  const p = path.join(os.homedir(), ...rel.split('/'));
  try {
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Replace every `${VAR}` token in `value` with `env[VAR]`. Returns the resolved
 *  string plus the names of any referenced variables absent from `env`. Pure. */
export function resolveVarRefs(
  value: string,
  env: Record<string, string | undefined>,
): { resolved: string; missing: string[] } {
  const missing: string[] = [];
  const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) {
      missing.push(name);
      return '';
    }
    return v;
  });
  return { resolved, missing };
}

function resolveMap(
  map: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
  missing: Set<string>,
): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    const r = resolveVarRefs(v, env);
    r.missing.forEach((m) => missing.add(m));
    out[k] = r.resolved;
  }
  return out;
}

/** Resolve a single server block's `${VAR}` refs (in env / headers). Returns the
 *  resolved block + the set of missing var names. Pure. */
export function resolveServerVars(
  block: McpServerBlock,
  env: Record<string, string | undefined>,
): { block: McpServerBlock; missing: string[] } {
  const missing = new Set<string>();
  let resolved: McpServerBlock;
  if (block.type === 'stdio') {
    resolved = { ...block, env: resolveMap(block.env, env, missing) };
  } else {
    resolved = { ...block, headers: resolveMap(block.headers, env, missing) };
  }
  return { block: resolved, missing: [...missing] };
}

export interface ParsedMcpConfig {
  /** Validated + `${VAR}`-resolved servers (name → block), ready for the provider
   *  to hand to the SDK `mcpServers` record. */
  servers: McpServersFile;
  /** Human-readable problems (bad JSON, invalid shape, missing env var). Caller
   *  surfaces these fail-loud; servers with missing vars are EXCLUDED. */
  errors: string[];
}

/** Parse raw `mcp-servers.json` text into validated, var-resolved servers. Pure
 *  (env injected) → unit-testable. A server that fails validation or references a
 *  missing env var is dropped WITH an error recorded (never silently skipped). */
export function parseMcpConfig(raw: string, env: Record<string, string | undefined>): ParsedMcpConfig {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    return { servers: {}, errors: [`mcp-servers.json is not valid JSON: ${err?.message ?? err}`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { servers: {}, errors: ['mcp-servers.json is not a keyed object'] };
  }
  const servers: McpServersFile = {};
  for (const [name, block] of Object.entries(parsed as Record<string, unknown>)) {
    const shapeError = validateMcpEntry(name, block);
    if (shapeError) {
      errors.push(`Skipping invalid MCP server: ${shapeError}`);
      continue;
    }
    const { block: resolved, missing } = resolveServerVars(block as McpServerBlock, env);
    if (missing.length) {
      errors.push(`MCP server "${name}" references env var(s) not set on this host: ${missing.join(', ')}`);
      continue;
    }
    servers[name] = resolved;
  }
  return { servers, errors };
}

/** Read + parse this app's projected MCP config. Missing file (no servers, or not
 *  yet projected) = empty, no error. */
export function loadProjectedMcpServers(
  appId: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ParsedMcpConfig {
  const p = resolveMcpConfigPath(appId);
  if (!p) return { servers: {}, errors: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err: any) {
    return { servers: {}, errors: [`Failed to read ${p}: ${err?.message ?? err}`] };
  }
  return parseMcpConfig(raw, env);
}
