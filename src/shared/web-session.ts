// Shared constants + payload shapes for the web session (login surface +
// agent `web.fetch`).
//
// The partition NAME is shared so the renderer's <webview> and main's
// session.fromPartition() resolve to the SAME cookie store. The `persist:`
// prefix makes cookies survive restarts → log in once, shared across all
// (local) projects. See the web-tab network-identity design.

export const WEB_SESSION_PARTITION = 'persist:web';

/**
 * Bare bridge-tool name the agent calls. Reaches main's canUseTool as
 * `mcp__shelf__browser_fetch` (real providers prefix MCP tools) or bare
 * `browser_fetch` (fake provider). Match with isWebFetchTool().
 *
 * NOT named `web_fetch`: the Claude Agent SDK now ships a built-in `web_fetch`
 * tool (generic anonymous public-web fetch on the agent's side) and a same-named
 * external tool errors out. Ours is distinct — it rides the user's logged-in
 * browser session (the web tab's `persist:web` cookies) — hence `browser_fetch`:
 * browser = carries your identity, vs web = anonymous public fetch.
 */
export const WEB_FETCH_TOOL = 'browser_fetch';

export function isWebFetchTool(toolName: string): boolean {
  return toolName === WEB_FETCH_TOOL || toolName.endsWith('__browser_fetch');
}

/**
 * Bare bridge-tool name the agent calls to OPEN a visible Web tab for the user
 * to log in (sibling of browser_fetch). Reaches canUseTool as
 * `mcp__shelf__browser_open` (real providers) or bare `browser_open` (fake).
 * Match with isBrowserOpenTool().
 */
export const BROWSER_OPEN_TOOL = 'browser_open';

export function isBrowserOpenTool(toolName: string): boolean {
  return toolName === BROWSER_OPEN_TOOL || toolName.endsWith('__browser_open');
}

/**
 * Metadata attached to a browser_open confirm popup. `origin` is parsed
 * authoritatively (anti-spoof); `url` is the full target shown to the user so
 * they see the exact login/service page before approving.
 */
export interface BrowserOpenMeta {
  /** Full absolute http(s) URL the tab will navigate to. */
  url: string;
  /** Canonical scheme://host[:port], parsed authoritatively (never the raw URL). */
  origin: string;
  /** eTLD+1 for display highlight (null if unknown). */
  registrableDomain: string | null;
}

/** Open/Deny — deliberately NO "remember" option (per-call confirm only). */
export type BrowserOpenDecision = 'open' | 'deny';

/** Anti-spoof origin metadata attached to a web.fetch permission request. */
export interface WebPermissionMeta {
  /** Canonical scheme://host[:port] — the grant key, parsed authoritatively. */
  origin: string;
  /** eTLD+1 for display highlight (null if unknown). */
  registrableDomain: string | null;
  method: string;
}

export interface WebFetchRequest {
  url: string;
  /** Defaults to GET. */
  method?: string;
  headers?: Record<string, string>;
  /** Raw request body (e.g. a JSON string for Kibana `_search`). */
  body?: string;
}

export interface WebFetchResult {
  status: number;
  headers: Record<string, string>;
  /** Raw response body. Redirects (not followed) have an empty body + Location header. */
  body: string;
}

/** A logged-in session, grouped by registrable domain, for the manage-sessions UI. */
export interface WebSessionEntry {
  domain: string;
  cookieCount: number;
}

/** All agent web.fetch grants, keyed by projectId → granted origins. */
export type WebGrantsByProject = Record<string, string[]>;
