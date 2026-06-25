import { getDomain } from 'tldts';

// Side-effect-free helpers for the web session. No electron / fs imports so this
// stays unit-testable. The security-critical bit lives here: origin parsing that
// defeats spoofing (userinfo / IDN / port tricks), used for the grant key and
// the permission prompt's anti-spoof display.
// Electron-coupled fetch lives in web-session.ts; persistence in web-grants.ts.

export interface ParsedOrigin {
  /** Canonical `scheme://host[:non-default-port]` — THE grant key. */
  origin: string;
  protocol: string; // 'https:'
  /** hostname[:port] as parsed (no userinfo). */
  host: string;
  /** Punycode hostname (IDN normalized) — what to display, never the raw input. */
  hostname: string;
  port: string;
  /** eTLD+1 for display highlighting only (NOT the grant key). */
  registrableDomain: string | null;
}

/**
 * Parse a URL into its canonical origin, rejecting anything that isn't http(s).
 *
 * Uses the WHATWG URL parser as the authoritative source: it strips userinfo
 * (`https://kibana.corp@evil.com` → host `evil.com`) and punycode-encodes IDN
 * (`https://kіbana.com` → `xn--…`), defeating the main origin-spoof vectors
 * before a human ever sees the permission prompt. Returns null for unparseable
 * or non-http(s) inputs.
 */
export function parseHttpOrigin(rawUrl: string): ParsedOrigin | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return {
    origin: u.origin,
    protocol: u.protocol,
    host: u.host,
    hostname: u.hostname,
    port: u.port,
    registrableDomain: getDomain(u.hostname),
  };
}
