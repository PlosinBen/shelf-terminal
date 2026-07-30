import { describe, it, expect, vi } from 'vitest';
import { driveDeviceCodeLogin, type LoginRpc } from './app-server-login';
import { CODEX_AUTH_DISPLAY_NAME } from './auth';
import type { OutgoingMessage } from '../types';

/** Fake JSON-RPC transport scripting the codex app-server login handshake. */
function fakeRpc(startResponse: unknown): LoginRpc & { fireCompleted: (success: boolean) => void } {
  const notif = new Map<string, (p: unknown) => void>();
  return {
    async request<T>(method: string): Promise<T> {
      if (method === 'initialize') return {} as T;
      if (method === 'account/login/start') return startResponse as T;
      throw new Error(`unexpected method ${method}`);
    },
    onNotification(method, handler) { notif.set(method, handler); },
    close: vi.fn(),
    fireCompleted(success: boolean) { notif.get('account/login/completed')?.({ success }); },
  };
}

const START = { type: 'chatgptDeviceCode', loginId: 'l1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' };

describe('driveDeviceCodeLogin', () => {
  it('emits auth_login_prompt then auth_login_done(ok) on completion', async () => {
    const rpc = fakeRpc(START);
    const wire: OutgoingMessage[] = [];
    driveDeviceCodeLogin(rpc, (m) => wire.push(m));
    await new Promise((r) => setTimeout(r, 0)); // let the async handshake run

    expect(wire).toEqual([
      { type: 'auth_login_prompt', provider: CODEX_AUTH_DISPLAY_NAME, verificationUri: START.verificationUrl, userCode: 'ABCD-1234', prefilledUri: START.verificationUrl },
    ]);

    rpc.fireCompleted(true);
    expect(wire.at(-1)).toEqual({ type: 'auth_login_done', provider: CODEX_AUTH_DISPLAY_NAME, ok: true });
    expect(rpc.close).toHaveBeenCalled();
  });

  it('cancel() emits auth_login_done(cancelled) and closes the transport', async () => {
    const rpc = fakeRpc(START);
    const wire: OutgoingMessage[] = [];
    const handle = driveDeviceCodeLogin(rpc, (m) => wire.push(m));
    await new Promise((r) => setTimeout(r, 0));
    handle.cancel();
    expect(wire.at(-1)).toEqual({ type: 'auth_login_done', provider: CODEX_AUTH_DISPLAY_NAME, ok: false, cancelled: true });
    expect(rpc.close).toHaveBeenCalled();
  });

  it('stamps injected display content on prompt and done events', async () => {
    const rpc = fakeRpc(START);
    const wire: OutgoingMessage[] = [];
    driveDeviceCodeLogin(rpc, (m) => wire.push(m), 'Codex Preview');
    await new Promise((r) => setTimeout(r, 0));
    rpc.fireCompleted(true);

    expect(wire[0]).toMatchObject({ type: 'auth_login_prompt', provider: 'Codex Preview' });
    expect(wire.at(-1)).toEqual({ type: 'auth_login_done', provider: 'Codex Preview', ok: true });
  });

  it('reports a failed handshake as auth_login_done(error)', async () => {
    const rpc: LoginRpc = {
      request: async <T>(m: string): Promise<T> => { if (m === 'initialize') throw new Error('boom'); return {} as T; },
      onNotification: () => {},
      close: vi.fn(),
    };
    const wire: OutgoingMessage[] = [];
    driveDeviceCodeLogin(rpc, (m) => wire.push(m));
    await new Promise((r) => setTimeout(r, 0));
    expect(wire.at(-1)).toMatchObject({
      type: 'auth_login_done',
      provider: CODEX_AUTH_DISPLAY_NAME,
      ok: false,
      error: 'boom',
    });
  });
});
