import { describe, it, expect } from 'vitest';
import { parseHttpOrigin } from './web-session-helpers';
import { isWebFetchTool } from '@shared/web-session';

describe('isWebFetchTool', () => {
  it('matches the bare name and the MCP-prefixed name', () => {
    expect(isWebFetchTool('web_fetch')).toBe(true);
    expect(isWebFetchTool('mcp__shelf__web_fetch')).toBe(true);
  });
  it('does not match other tools', () => {
    expect(isWebFetchTool('mcp__shelf__list_app_skills')).toBe(false);
    expect(isWebFetchTool('Bash')).toBe(false);
    expect(isWebFetchTool('web_fetch_other')).toBe(false);
  });
});

describe('parseHttpOrigin', () => {
  it('parses a plain https URL to its canonical origin', () => {
    const p = parseHttpOrigin('https://kibana.corp.com/api/console/proxy');
    expect(p?.origin).toBe('https://kibana.corp.com');
    expect(p?.registrableDomain).toBe('corp.com');
    expect(p?.port).toBe('');
  });

  it('strips userinfo — the real host wins (anti-spoof)', () => {
    // Looks like kibana.corp.com but the actual host is evil.com.
    const p = parseHttpOrigin('https://kibana.corp.com@evil.com/x');
    expect(p?.origin).toBe('https://evil.com');
    expect(p?.host).toBe('evil.com');
    expect(p?.registrableDomain).toBe('evil.com');
  });

  it('punycode-encodes IDN lookalikes', () => {
    // "kіbana" uses a Cyrillic і (U+0456), not ASCII i.
    const p = parseHttpOrigin('https://kіbana.com/');
    expect(p?.hostname.startsWith('xn--')).toBe(true);
    expect(p?.hostname).not.toContain('і');
  });

  it('keeps non-default ports in the origin key, drops default ports', () => {
    expect(parseHttpOrigin('http://localhost:5601/')?.origin).toBe('http://localhost:5601');
    expect(parseHttpOrigin('http://localhost:5601/')?.port).toBe('5601');
    expect(parseHttpOrigin('https://x.com:443/')?.origin).toBe('https://x.com');
  });

  it('distinguishes scheme and subdomain (least-privilege key)', () => {
    expect(parseHttpOrigin('http://x.com/')?.origin).not.toBe(parseHttpOrigin('https://x.com/')?.origin);
    expect(parseHttpOrigin('https://kibana.corp.com/')?.origin).not.toBe(
      parseHttpOrigin('https://argocd.corp.com/')?.origin,
    );
  });

  it('rejects non-http(s) and unparseable input', () => {
    expect(parseHttpOrigin('ftp://x.com/')).toBeNull();
    expect(parseHttpOrigin('file:///etc/passwd')).toBeNull();
    expect(parseHttpOrigin('not a url')).toBeNull();
    expect(parseHttpOrigin('')).toBeNull();
  });
});
