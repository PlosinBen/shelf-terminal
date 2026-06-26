import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Capture the options passed to net.request so we can assert the cookie/redirect
// contract. A fake request emits a minimal 200 response so webFetch resolves.
let lastRequestOptions: Record<string, unknown> | null = null;

function makeFakeRequest() {
  const req = new EventEmitter() as EventEmitter & {
    setHeader: (k: string, v: string) => void;
    write: (b: string) => void;
    end: () => void;
    abort: () => void;
  };
  req.setHeader = vi.fn();
  req.write = vi.fn();
  req.abort = vi.fn();
  req.end = () => {
    // Emit a tiny response on the next tick, mirroring net.request.
    queueMicrotask(() => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
      res.statusCode = 200;
      res.headers = { 'content-type': 'text/plain' };
      req.emit('response', res);
      res.emit('data', Buffer.from('ok'));
      res.emit('end');
    });
  };
  return req;
}

vi.mock('electron', () => ({
  net: {
    request: (opts: Record<string, unknown>) => {
      lastRequestOptions = opts;
      return makeFakeRequest();
    },
  },
  session: { fromPartition: () => ({ cookies: { get: async () => [] } }) },
}));

const { webFetch } = await import('./web-session');

describe('webFetch — request contract', () => {
  beforeEach(() => { lastRequestOptions = null; });

  it('rides the logged-in cookie jar (useSessionCookies:true) and never auto-follows redirects', async () => {
    const res = await webFetch({ url: 'https://kibana.corp.com/api/spaces/space' });
    expect(res.status).toBe(200);
    // Regression: without useSessionCookies, Electron sends no session cookie and
    // every authed request 401s despite the user being logged in.
    expect(lastRequestOptions?.useSessionCookies).toBe(true);
    // Redirects must stay manual — auto-follow would leak cookies to un-granted origins.
    expect(lastRequestOptions?.redirect).toBe('manual');
  });

  it('rejects non-http(s) URLs before issuing a request', async () => {
    await expect(webFetch({ url: 'file:///etc/passwd' })).rejects.toThrow();
    expect(lastRequestOptions).toBeNull();
  });
});
