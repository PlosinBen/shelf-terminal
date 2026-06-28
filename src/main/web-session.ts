import { net, session, type Session } from 'electron';
import { getDomain } from 'tldts';
import {
  WEB_SESSION_PARTITION,
  type WebFetchRequest,
  type WebFetchResult,
  type WebSessionEntry,
} from '@shared/web-session';
import { parseHttpOrigin } from './web-session-helpers';
import { log } from '@shared/logger';

function registrableOf(cookieDomain: string | undefined): string {
  const bare = (cookieDomain ?? '').replace(/^\./, '');
  return getDomain(bare) ?? bare;
}

// Main-side owner of the shared web session (cookies live here, in main; the
// renderer's <webview> only borrows the same partition name to log in). The
// agent's `web.fetch` op runs through this — main rides the logged-in cookie
// jar, the agent never touches cookies. See the web-tab network-identity design.

export function getWebSession(): Session {
  return session.fromPartition(WEB_SESSION_PARTITION);
}

/**
 * Authenticated fetch riding the shared web session's cookie jar. Returns the
 * RAW response ({status, headers, body}) — no auth/expiry interpretation. "Not
 * logged in" has no reliable wire signal (sites use 401/400/302/200+login-page),
 * so we hand the truth back and let the agent/user judge.
 *
 * Security: `redirect: 'manual'` — redirects are NEVER auto-followed (auto-follow
 * is a classic allowlist-bypass: a granted origin could 302 your cookies to an
 * un-granted one). A redirect just returns as its 3xx status + Location header.
 * Rejects non-http(s) / unparseable URLs up front.
 *
 * Grant enforcement is the caller's job (app-tool layer): this assumes the
 * origin is already authorized.
 */
export function webFetch(req: WebFetchRequest): Promise<WebFetchResult> {
  const parsed = parseHttpOrigin(req.url);
  if (!parsed) {
    return Promise.reject(new Error(`web.fetch: invalid or non-http(s) URL: ${req.url}`));
  }

  return new Promise<WebFetchResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const request = net.request({
      url: req.url,
      method: req.method ?? 'GET',
      session: getWebSession(),
      // Ride the logged-in cookie jar. Electron's net.request does NOT send
      // session cookies unless this is set — without it every authed request
      // comes back 401 even though the user is signed in. This is the whole
      // point of browser_fetch (vs the agent's anonymous web_fetch).
      useSessionCookies: true,
      redirect: 'manual', // do NOT follow — see doc comment above
    });

    for (const [key, value] of Object.entries(req.headers ?? {})) {
      request.setHeader(key, value);
    }

    request.on('redirect', (statusCode, _method, redirectUrl) => {
      // Manual mode: by NOT calling request.followRedirect() the chain stops.
      // Return the redirect as-is (status + Location) for the caller to read.
      settle(() =>
        resolve({ status: statusCode, headers: { location: redirectUrl }, body: '' }),
      );
      request.abort();
    });

    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        settle(() =>
          resolve({
            status: response.statusCode,
            headers: flattenHeaders(response.headers),
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      });
      response.on('error', (err: Error) => settle(() => reject(err)));
    });

    request.on('error', (err) => settle(() => reject(err)));

    if (req.body != null) request.write(req.body);
    request.end();
  });
}

/**
 * List logged-in sessions, grouped by registrable domain (eTLD+1), for the
 * "manage sessions" UI. Hygiene surface — lets the user see and delete what
 * they're logged into. NOT an access boundary (that's the permission gate).
 */
export async function listSessions(): Promise<WebSessionEntry[]> {
  const cookies = await getWebSession().cookies.get({});
  const counts = new Map<string, number>();
  for (const c of cookies) {
    const domain = registrableOf(c.domain);
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([domain, cookieCount]) => ({ domain, cookieCount }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

/** Delete every cookie under a registrable domain (log out of that service). */
export async function deleteSession(domain: string): Promise<void> {
  const ses = getWebSession();
  const cookies = await ses.cookies.get({});
  for (const c of cookies) {
    if (registrableOf(c.domain) !== domain) continue;
    const host = (c.domain ?? '').replace(/^\./, '');
    const url = `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`;
    try {
      await ses.cookies.remove(url, c.name);
    } catch (err) {
      log.error('web-session', `cookie remove failed: ${c.name}@${host}`, err);
    }
  }
  await ses.cookies.flushStore();
}

function flattenHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
