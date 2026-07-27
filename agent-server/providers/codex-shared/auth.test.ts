import { describe, expect, it } from 'vitest';
import { authLoginDone, deviceCodeToAuthPrompt } from './auth';

describe('shared Codex device-code auth mapping', () => {
  it('defaults to the legacy codex provider id', () => {
    expect(deviceCodeToAuthPrompt({ verificationUrl: 'https://chatgpt.com/device', userCode: 'ABCD-1234' })).toEqual({
      type: 'auth_login_prompt',
      provider: 'codex',
      verificationUri: 'https://chatgpt.com/device',
      userCode: 'ABCD-1234',
      prefilledUri: 'https://chatgpt.com/device',
    });
    expect(authLoginDone(true)).toEqual({ type: 'auth_login_done', provider: 'codex', ok: true });
  });

  it('can stamp the temporary official-SDK provider id', () => {
    expect(
      deviceCodeToAuthPrompt(
        { verificationUrl: 'https://chatgpt.com/device', userCode: 'WXYZ-9999' },
        'codex-offical',
      ),
    ).toMatchObject({ type: 'auth_login_prompt', provider: 'codex-offical' });
    expect(authLoginDone(false, { provider: 'codex-offical', cancelled: true })).toEqual({
      type: 'auth_login_done',
      provider: 'codex-offical',
      ok: false,
      cancelled: true,
    });
  });
});
