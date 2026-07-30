import { describe, expect, it } from 'vitest';
import { CODEX_AUTH_DISPLAY_NAME, authLoginDone, deviceCodeToAuthPrompt } from './auth';

describe('shared Codex device-code auth mapping', () => {
  it('defaults to provider-owned display content', () => {
    expect(deviceCodeToAuthPrompt({ verificationUrl: 'https://chatgpt.com/device', userCode: 'ABCD-1234' })).toEqual({
      type: 'auth_login_prompt',
      provider: CODEX_AUTH_DISPLAY_NAME,
      verificationUri: 'https://chatgpt.com/device',
      userCode: 'ABCD-1234',
      prefilledUri: 'https://chatgpt.com/device',
    });
    expect(authLoginDone(true)).toEqual({
      type: 'auth_login_done',
      provider: CODEX_AUTH_DISPLAY_NAME,
      ok: true,
    });
  });

  it('passes injected display content through verbatim', () => {
    expect(
      deviceCodeToAuthPrompt(
        { verificationUrl: 'https://chatgpt.com/device', userCode: 'WXYZ-9999' },
        'Codex Preview',
      ),
    ).toMatchObject({ type: 'auth_login_prompt', provider: 'Codex Preview' });
    expect(authLoginDone(false, { provider: 'Codex Preview', cancelled: true })).toEqual({
      type: 'auth_login_done',
      provider: 'Codex Preview',
      ok: false,
      cancelled: true,
    });
  });
});
