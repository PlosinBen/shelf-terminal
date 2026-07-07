import { describe, it, expect } from 'vitest';
import { parseLoginPrompt, prefillLoginUrl } from './login';

describe('parseLoginPrompt', () => {
  it('parses the primary headless prompt line', () => {
    const line = 'To authenticate, visit https://github.com/login/device and enter code 1E5E-903B.';
    expect(parseLoginPrompt(line)).toEqual({
      verificationUri: 'https://github.com/login/device',
      userCode: '1E5E-903B',
    });
  });

  it('parses the clipboard-fallback "enter the code … manually" line', () => {
    const line = 'Failed to copy to clipboard. Please visit https://github.com/login/device and enter the code 1E5E-903B manually.';
    expect(parseLoginPrompt(line)).toEqual({
      verificationUri: 'https://github.com/login/device',
      userCode: '1E5E-903B',
    });
  });

  it('handles all-digit and all-letter codes', () => {
    expect(parseLoginPrompt('visit https://github.com/login/device and enter code 1234-5678')?.userCode).toBe('1234-5678');
    expect(parseLoginPrompt('visit https://github.com/login/device and enter code ABCD-WXYZ')?.userCode).toBe('ABCD-WXYZ');
  });

  it('supports GitHub Enterprise hosts', () => {
    const line = 'visit https://mycompany.ghe.com/login/device and enter code AB12-CD34.';
    expect(parseLoginPrompt(line)).toEqual({
      verificationUri: 'https://mycompany.ghe.com/login/device',
      userCode: 'AB12-CD34',
    });
  });

  it('returns null for noise / polling lines', () => {
    expect(parseLoginPrompt('Waiting for authorization...')).toBeNull();
    expect(parseLoginPrompt('Login failed: TypeError: fetch failed')).toBeNull();
    expect(parseLoginPrompt('')).toBeNull();
    // a URL but no code
    expect(parseLoginPrompt('See https://github.com/login/device for details')).toBeNull();
    // a code but no URL
    expect(parseLoginPrompt('Your code is 1E5E-903B')).toBeNull();
  });

  it('does not misfire on a code-like substring that is not a device code', () => {
    // 3-char groups should not match
    expect(parseLoginPrompt('visit https://x/login and enter code ABC-DEF')).toBeNull();
  });
});

describe('prefillLoginUrl', () => {
  it('appends user_code as a query param', () => {
    expect(prefillLoginUrl({ verificationUri: 'https://github.com/login/device', userCode: '1E5E-903B' }))
      .toBe('https://github.com/login/device?user_code=1E5E-903B');
  });

  it('falls back to the bare uri when not parseable', () => {
    expect(prefillLoginUrl({ verificationUri: 'not a url', userCode: '1E5E-903B' })).toBe('not a url');
  });
});
