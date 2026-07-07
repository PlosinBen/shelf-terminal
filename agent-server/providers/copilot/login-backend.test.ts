import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OutgoingMessage } from '../types';

/**
 * Glue-layer test: the copilot backend's startLogin/cancelLogin wire the pure
 * `./login` runner to the `auth_login_prompt` / `auth_login_done` wire events.
 * The runner itself is covered in login.test.ts; here we mock it to assert the
 * backend forwards prompt (with prefilledUri) and the terminal result.
 */

const h = vi.hoisted(() => ({
  cliExists: true,
  onPrompt: null as null | ((p: { verificationUri: string; userCode: string }) => void),
  resolveDone: null as null | ((r: any) => void),
  cancel: null as any,
}));

vi.mock('fs', () => ({ existsSync: () => h.cliExists }));

vi.mock('./login', async (orig) => {
  const actual = await (orig() as Promise<any>);
  return {
    ...actual, // keep the real prefillLoginUrl
    startLogin: (opts: any) => {
      h.onPrompt = opts.onPrompt;
      h.cancel = vi.fn();
      return { cancel: h.cancel, done: new Promise((r) => { h.resolveDone = r; }) };
    },
  };
});

import { createCopilotBackend } from './index';

describe('copilot backend startLogin', () => {
  beforeEach(() => {
    h.cliExists = true;
    h.onPrompt = null;
    h.resolveDone = null;
    h.cancel = null;
  });

  it('forwards prompt as auth_login_prompt with a prefilled url, then done', async () => {
    const backend = createCopilotBackend();
    const sent: OutgoingMessage[] = [];
    backend.startLogin!('/tmp', (m) => sent.push(m));

    h.onPrompt!({ verificationUri: 'https://github.com/login/device', userCode: '1E5E-903B' });
    expect(sent).toContainEqual({
      type: 'auth_login_prompt',
      provider: 'copilot',
      verificationUri: 'https://github.com/login/device',
      userCode: '1E5E-903B',
      prefilledUri: 'https://github.com/login/device?user_code=1E5E-903B',
    });

    h.resolveDone!({ ok: true });
    await Promise.resolve(); await Promise.resolve();
    expect(sent).toContainEqual({ type: 'auth_login_done', provider: 'copilot', ok: true, cancelled: undefined, error: undefined });
  });

  it('emits auth_login_done ok:false when the CLI is not found', () => {
    h.cliExists = false;
    const backend = createCopilotBackend();
    const sent: OutgoingMessage[] = [];
    backend.startLogin!('/tmp', (m) => sent.push(m));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'auth_login_done', provider: 'copilot', ok: false });
  });

  it('cancelLogin kills the running login child', () => {
    const backend = createCopilotBackend();
    backend.startLogin!('/tmp', () => {});
    backend.cancelLogin!();
    expect(h.cancel).toHaveBeenCalled();
  });

  it('forwards a cancelled result', async () => {
    const backend = createCopilotBackend();
    const sent: OutgoingMessage[] = [];
    backend.startLogin!('/tmp', (m) => sent.push(m));
    h.resolveDone!({ ok: false, cancelled: true });
    await Promise.resolve(); await Promise.resolve();
    expect(sent).toContainEqual({ type: 'auth_login_done', provider: 'copilot', ok: false, cancelled: true, error: undefined });
  });
});
