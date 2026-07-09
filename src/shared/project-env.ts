/**
 * Project-level environment variables — pure, dependency-free helpers shared by
 * the main process (resolve + inject) and the renderer (config-UI validation).
 *
 * Model: a project carries a map of user-set env vars that Shelf injects into
 * EVERY process it launches for that project (the agent-server and its CLIs, and
 * the project's interactive terminals). Two categories exist — `plain` (stored in
 * projectConfig, this file's `EnvMap`) and `secret` (encrypted side-car, added
 * later) — but both resolve to the same injected env map; only storage/display
 * differ.
 *
 * Precedence (ecosystem norm — silent override, no warnings): ambient/inherited
 * env  <  project env  <  Shelf's own required vars (applied last as a backstop).
 * `PATH` is the one exception: it MERGES (project entry prepended) instead of
 * replacing, so injecting a project PATH never breaks binary lookup. A small set
 * of Shelf-owned keys is RESERVED — the config UI blocks them at input and
 * injection drops them defensively.
 */

/** A resolved env map (KEY → value). */
export type EnvMap = Record<string, string>;

/**
 * Shelf-owned env namespace. Reserved keys can't be set at the project level:
 * the `SHELF_*` prefix is Shelf's own control channel (test mode, dispatcher
 * toggles, session leases…), and `ELECTRON_RUN_AS_NODE` flips the app binary
 * between Electron and plain-Node — overriding it would boot a stray window or
 * break the agent-server. Single source of truth; adding a new `SHELF_*` var is
 * auto-reserved.
 */
export const SHELF_RESERVED_ENV = {
  /** Any variable whose name starts with one of these prefixes is Shelf-owned. */
  prefixes: ['SHELF_'] as readonly string[],
  /** Specific non-prefixed variables Shelf sets and must not be overridden. */
  keys: ['ELECTRON_RUN_AS_NODE'] as readonly string[],
} as const;

/** True if `key` is reserved by Shelf and must not be set at the project level. */
export function isReservedEnvKey(key: string): boolean {
  return SHELF_RESERVED_ENV.prefixes.some((p) => key.startsWith(p))
    || SHELF_RESERVED_ENV.keys.includes(key);
}

/** POSIX env-var name shape (letters/underscore, then letters/digits/underscore). */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate one env-var name for the project-config UI. `otherKeys` are the other
 * keys already present (across BOTH plain and secret — a single injected env var
 * can't be defined twice). Returns a short error string, or null if the key is
 * acceptable. An empty key (a blank row being typed) is treated as not-yet-an-error.
 */
export function validateEnvKey(key: string, otherKeys: readonly string[] = []): string | null {
  if (key === '') return null;
  if (!ENV_KEY_RE.test(key)) return 'Invalid variable name';
  if (isReservedEnvKey(key)) return 'Reserved by Shelf';
  if (otherKeys.includes(key)) return 'Duplicate variable';
  return null;
}

/**
 * Drop reserved keys and non-string values from a raw project env map. Defensive
 * backstop for values arriving from imported/hand-edited config that bypassed the
 * UI's input validation.
 */
export function sanitizeEnvMap(raw: Record<string, unknown> | undefined | null): EnvMap {
  const out: EnvMap = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (isReservedEnvKey(k)) continue;
    if (!ENV_KEY_RE.test(k)) continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Merge a resolved project env map onto a base env map (for a LOCAL child's
 * `env` option). Base = ambient/inherited; project overrides silently. `PATH`
 * merges (project entry prepended to the base PATH) instead of replacing.
 * Reserved keys in `projectEnv` are ignored (backstop). The caller is expected
 * to apply Shelf-required vars AFTER this (the backstop layer).
 */
export function applyEnvMap(
  base: Record<string, string | undefined>,
  projectEnv: EnvMap,
): EnvMap {
  const out: EnvMap = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') out[k] = v;
  for (const [k, v] of Object.entries(projectEnv)) {
    if (isReservedEnvKey(k)) continue;
    if (k === 'PATH') out.PATH = out.PATH ? `${v}:${out.PATH}` : v;
    else out[k] = v;
  }
  return out;
}

/** POSIX single-quote escape: wrap in '…' and encode any embedded quote. */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a POSIX `export K='v'; …` prefix from a project env map, for a REMOTE
 * shell command (ssh/docker/wsl) where the child inherits the target's ambient
 * env. Values are single-quoted. `PATH` is emitted as a merge
 * (`export PATH='…':"$PATH"`) so the target's own PATH is preserved. Reserved
 * keys are dropped (backstop). Returns '' for an empty map (no-op prefix).
 */
export function buildEnvExportPrefix(projectEnv: EnvMap): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(projectEnv)) {
    if (isReservedEnvKey(k)) continue;
    if (!ENV_KEY_RE.test(k)) continue;
    if (k === 'PATH') parts.push(`export PATH=${shSingleQuote(v)}:"$PATH"`);
    else parts.push(`export ${k}=${shSingleQuote(v)}`);
  }
  return parts.length ? parts.join('; ') + '; ' : '';
}
