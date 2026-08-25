import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_URL_INTENT_LIMITS,
  validateExternalUrlIntent,
} from './external-url-intent';

describe('validateExternalUrlIntent', () => {
  it('keeps the exact HTTPS URL while deriving an origin safe for diagnostics', () => {
    const url = 'https://login.example.com/oauth/authorize?state=secret-state&code=secret-code';

    expect(validateExternalUrlIntent({
      url,
      reason: 'Sign in to the provider',
      source: { kind: 'project-tab', projectId: 'project-1', tabId: 'agent-1' },
    })).toEqual({
      ok: true,
      intent: {
        url,
        reason: 'Sign in to the provider',
        source: { kind: 'project-tab', projectId: 'project-1', tabId: 'agent-1' },
        destination: { kind: 'web-origin', origin: 'https://login.example.com' },
      },
    });
  });

  it('accepts an app-window source without inventing project identity', () => {
    expect(validateExternalUrlIntent({
      url: 'http://localhost:4312/callback',
      reason: 'Navigation attempted outside Shelf',
      source: { kind: 'app-window' },
    })).toMatchObject({
      ok: true,
      intent: {
        source: { kind: 'app-window' },
        destination: { kind: 'web-origin', origin: 'http://localhost:4312' },
      },
    });
  });

  it('derives a decoded mail destination for mailto URLs', () => {
    const result = validateExternalUrlIntent({
      url: 'mailto:hello%2Bsupport@example.com?subject=Private',
      reason: 'Contact support',
      source: { kind: 'project-tab', projectId: 'project-1', tabId: 'notes-1' },
    });

    expect(result).toEqual({
      ok: true,
      intent: {
        url: 'mailto:hello%2Bsupport@example.com?subject=Private',
        reason: 'Contact support',
        source: { kind: 'project-tab', projectId: 'project-1', tabId: 'notes-1' },
        destination: { kind: 'mail-address', address: 'hello+support@example.com' },
      },
    });
  });

  it.each([
    ['unsupported scheme', { url: 'file:///tmp/private', reason: 'Open file', source: { kind: 'app-window' } }, 'unsupported-scheme'],
    ['relative URL', { url: '/login', reason: 'Sign in', source: { kind: 'app-window' } }, 'malformed-url'],
    ['credentials in HTTP URL', { url: 'https://user:password@example.com/', reason: 'Sign in', source: { kind: 'app-window' } }, 'embedded-credentials'],
    ['empty mail destination', { url: 'mailto:?subject=Hello', reason: 'Send mail', source: { kind: 'app-window' } }, 'missing-mail-destination'],
    ['malformed mail escape', { url: 'mailto:user%ZZ@example.com', reason: 'Send mail', source: { kind: 'app-window' } }, 'malformed-mail-destination'],
    ['missing project id', { url: 'https://example.com', reason: 'Open docs', source: { kind: 'project-tab', projectId: '', tabId: 'tab-1' } }, 'invalid-source'],
    ['unknown source kind', { url: 'https://example.com', reason: 'Open docs', source: { kind: 'active-project' } }, 'invalid-source'],
  ] as const)('rejects %s without reflecting the URL in the error', (_label, input, code) => {
    const result = validateExternalUrlIntent(input);

    expect(result).toEqual({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain(input.url);
  });

  it('enforces bounded URL and reason inputs', () => {
    expect(validateExternalUrlIntent({
      url: `https://example.com/?q=${'x'.repeat(EXTERNAL_URL_INTENT_LIMITS.url)}`,
      reason: 'Open docs',
      source: { kind: 'app-window' },
    })).toEqual({ ok: false, code: 'url-too-long' });

    expect(validateExternalUrlIntent({
      url: 'https://example.com',
      reason: 'x'.repeat(EXTERNAL_URL_INTENT_LIMITS.reason + 1),
      source: { kind: 'app-window' },
    })).toEqual({ ok: false, code: 'invalid-reason' });
  });
});
