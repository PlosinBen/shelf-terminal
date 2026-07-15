import { describe, it, expect } from 'vitest';
import { deviceCodeToAuthPrompt, authLoginDone } from './auth';

describe('codex device-code auth mapping', () => {
  it('maps a device-code login response → auth_login_prompt (Copilot-shaped)', () => {
    expect(deviceCodeToAuthPrompt({ verificationUrl: 'https://chatgpt.com/device', userCode: 'ABCD-1234' })).toEqual({
      type: 'auth_login_prompt',
      provider: 'codex',
      verificationUri: 'https://chatgpt.com/device',
      userCode: 'ABCD-1234',
      prefilledUri: 'https://chatgpt.com/device',
    });
  });

  it('maps terminal outcomes → auth_login_done', () => {
    expect(authLoginDone(true)).toEqual({ type: 'auth_login_done', provider: 'codex', ok: true });
    expect(authLoginDone(false, { cancelled: true })).toEqual({ type: 'auth_login_done', provider: 'codex', ok: false, cancelled: true });
    expect(authLoginDone(false, { error: 'boom' })).toEqual({ type: 'auth_login_done', provider: 'codex', ok: false, error: 'boom' });
  });
});
