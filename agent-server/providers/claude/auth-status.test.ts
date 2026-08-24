import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_CLI_AUTH_OUTCOME, parseClaudeAuthStatus, probeClaudeCliAuth } from './auth-status';

describe('parseClaudeAuthStatus', () => {
  it('treats a logged-out first-party account as unauthenticated', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({
      loggedIn: false,
      authMethod: 'none',
      apiProvider: 'firstParty',
    }))).toEqual({ outcome: CLAUDE_CLI_AUTH_OUTCOME.UNAUTHENTICATED });
  });

  it('treats a logged-in first-party account as authenticated', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
    }))).toEqual({ outcome: CLAUDE_CLI_AUTH_OUTCOME.AUTHENTICATED });
  });

  it('does not block providers whose credentials are managed externally', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({
      loggedIn: false,
      authMethod: 'none',
      apiProvider: 'bedrock',
    }))).toEqual({ outcome: CLAUDE_CLI_AUTH_OUTCOME.AUTHENTICATED });
  });

  it('returns unknown for malformed or incomplete output', () => {
    expect(parseClaudeAuthStatus('not json')).toMatchObject({ outcome: CLAUDE_CLI_AUTH_OUTCOME.UNKNOWN });
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }))).toMatchObject({ outcome: CLAUDE_CLI_AUTH_OUTCOME.UNKNOWN });
  });
});

describe('probeClaudeCliAuth', () => {
  it('uses the provider binary and the official auth status command', async () => {
    const execFile = vi.fn((_command, _args, _options, callback) => {
      callback(null, JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }), '');
      return {} as never;
    });

    await expect(probeClaudeCliAuth('/opt/shelf/claude', { execFile: execFile as never }))
      .resolves.toEqual({ outcome: CLAUDE_CLI_AUTH_OUTCOME.UNAUTHENTICATED });
    expect(execFile).toHaveBeenCalledWith(
      '/opt/shelf/claude',
      ['auth', 'status', '--json'],
      expect.objectContaining({ encoding: 'utf8' }),
      expect.any(Function),
    );
  });

  it('returns an observable unknown result when the command fails', async () => {
    const execFile = vi.fn((_command, _args, _options, callback) => {
      callback(new Error('spawn failed'), '', 'detail');
      return {} as never;
    });

    await expect(probeClaudeCliAuth(undefined, { execFile: execFile as never }))
      .resolves.toEqual({ outcome: CLAUDE_CLI_AUTH_OUTCOME.UNKNOWN, error: 'spawn failed: detail' });
    expect(execFile.mock.calls[0][0]).toBe('claude');
  });
});
