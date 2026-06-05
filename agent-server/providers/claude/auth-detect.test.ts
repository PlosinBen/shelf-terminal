import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tab-open auth detection: claude's ensureInit warmup is a real SDK init; we
 * read the message stream for a structured auth-failure signal and surface it
 * as gatherCapabilities().authRequired. These tests mock the SDK `query` so we
 * can drive each outcome (authed / auth-failed / unknown) deterministically.
 */

// Mock the SDK BEFORE importing the provider (index.ts does a value import of
// `query`). The mock returns an async-iterable that also carries
// supportedModels()/supportedCommands(), matching the SDK's Query object.
const sdkQueryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => sdkQueryMock(...args),
}));

import { createClaudeBackend, isClaudeAuthFailure } from './index';

/**
 * Build a fake SDK Query: async-iterates `messages`, exposes model/command
 * lists, and answers accountInfo() — the control-channel auth probe. The
 * default account is the verified LOGGED-OUT shape.
 */
function fakeQuery(
  messages: any[],
  opts: { models?: any[]; commands?: any[]; account?: any; accountThrows?: boolean } = {},
) {
  async function* gen() {
    for (const m of messages) yield m;
  }
  const it: any = gen();
  it.supportedModels = async () => opts.models ?? [];
  it.supportedCommands = async () => opts.commands ?? [];
  it.accountInfo = async () => {
    if (opts.accountThrows) throw new Error('control error');
    // Verified logged-out shape: tokenSource 'none', apiProvider present.
    return opts.account ?? { tokenSource: 'none', apiProvider: 'firstParty' };
  };
  return it;
}

const INIT = { type: 'system', subtype: 'init', session_id: 's1' };
const SIGNED_IN = { tokenSource: 'oauth', email: 'a@b.c', apiProvider: 'firstParty' };
const SIGNED_OUT = { tokenSource: 'none', apiProvider: 'firstParty' };

describe('isClaudeAuthFailure', () => {
  it('flags a settled auth_status failure', () => {
    expect(isClaudeAuthFailure({ type: 'auth_status', isAuthenticating: false, error: 'nope' })).toBe(true);
  });

  it('flags assistant authentication_failed / oauth_org_not_allowed', () => {
    expect(isClaudeAuthFailure({ type: 'assistant', error: 'authentication_failed' })).toBe(true);
    expect(isClaudeAuthFailure({ type: 'assistant', error: 'oauth_org_not_allowed' })).toBe(true);
  });

  it('does NOT flag transient / non-auth signals', () => {
    expect(isClaudeAuthFailure({ type: 'auth_status', isAuthenticating: true })).toBe(false);
    expect(isClaudeAuthFailure({ type: 'auth_status', isAuthenticating: false })).toBe(false); // no error
    expect(isClaudeAuthFailure({ type: 'assistant', error: 'rate_limit' })).toBe(false);
    expect(isClaudeAuthFailure({ type: 'assistant', error: 'server_error' })).toBe(false);
    expect(isClaudeAuthFailure({ type: 'system', subtype: 'init' })).toBe(false);
  });
});

describe('gatherCapabilities authRequired', () => {
  beforeEach(() => {
    sdkQueryMock.mockReset();
  });

  it('signed in: init + accountInfo(tokenSource!=none) → authRequired false, cached', async () => {
    sdkQueryMock.mockImplementation(() =>
      fakeQuery([INIT], { models: [{ value: 'opus', displayName: 'Opus' }], commands: [{ name: 'clear', description: 'x' }], account: SIGNED_IN }),
    );
    const backend = createClaudeBackend();
    const caps = await backend.gatherCapabilities!('/tmp');
    expect(caps.authRequired).toBe(false);
    expect(caps.models.length).toBeGreaterThan(0);

    // Second call short-circuits via cache — SDK not re-queried.
    await backend.gatherCapabilities!('/tmp');
    expect(sdkQueryMock).toHaveBeenCalledTimes(1);
  });

  it('logged out: accountInfo tokenSource "none" → authRequired true, NOT cached (re-probes)', async () => {
    sdkQueryMock.mockImplementation(() => fakeQuery([INIT], { account: SIGNED_OUT }));
    const backend = createClaudeBackend();
    const caps = await backend.gatherCapabilities!('/tmp');
    expect(caps.authRequired).toBe(true);

    // A failed probe must NOT be memoized — a retry re-runs the SDK init.
    await backend.gatherCapabilities!('/tmp');
    expect(sdkQueryMock).toHaveBeenCalledTimes(2);
  });

  it('auth failure frame BEFORE init (auth_status) → authRequired true', async () => {
    sdkQueryMock.mockImplementation(() =>
      fakeQuery([{ type: 'auth_status', isAuthenticating: false, error: 'not_logged_in' }]),
    );
    const backend = createClaudeBackend();
    expect((await backend.gatherCapabilities!('/tmp')).authRequired).toBe(true);
  });

  it('auth failure frame BEFORE init (assistant.error) → authRequired true', async () => {
    sdkQueryMock.mockImplementation(() =>
      fakeQuery([{ type: 'assistant', error: 'authentication_failed' }]),
    );
    const backend = createClaudeBackend();
    expect((await backend.gatherCapabilities!('/tmp')).authRequired).toBe(true);
  });

  it('accountInfo throws → error (authRequired false, do not block the pane)', async () => {
    sdkQueryMock.mockImplementation(() => fakeQuery([INIT], { accountThrows: true }));
    const backend = createClaudeBackend();
    expect((await backend.gatherCapabilities!('/tmp')).authRequired).toBe(false);
  });

  it('unknown (no init, no auth signal) → authRequired false', async () => {
    sdkQueryMock.mockImplementation(() => fakeQuery([]));
    const backend = createClaudeBackend();
    expect((await backend.gatherCapabilities!('/tmp')).authRequired).toBe(false);
  });

  it('recovers after login: logged-out then signed-in flips authRequired to false', async () => {
    sdkQueryMock
      .mockImplementationOnce(() => fakeQuery([INIT], { account: SIGNED_OUT }))
      .mockImplementationOnce(() => fakeQuery([INIT], { models: [{ value: 'opus', displayName: 'Opus' }], commands: [], account: SIGNED_IN }));
    const backend = createClaudeBackend();
    expect((await backend.gatherCapabilities!('/tmp')).authRequired).toBe(true);
    expect((await backend.gatherCapabilities!('/tmp')).authRequired).toBe(false);
    expect(sdkQueryMock).toHaveBeenCalledTimes(2);
  });
});
