import { describe, it, expect, vi } from 'vitest';
import { driveDeviceCodeLogin, type LoginRpc } from './app-server-login';
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
      { type: 'auth_login_prompt', provider: 'codex', verificationUri: START.verificationUrl, userCode: 'ABCD-1234', prefilledUri: START.verificationUrl },
    ]);

    rpc.fireCompleted(true);
    expect(wire.at(-1)).toEqual({ type: 'auth_login_done', provider: 'codex', ok: true });
    expect(rpc.close).toHaveBeenCalled();
  });

  it('cancel() emits auth_login_done(cancelled) and closes the transport', async () => {
    const rpc = fakeRpc(START);
    const wire: OutgoingMessage[] = [];
    const handle = driveDeviceCodeLogin(rpc, (m) => wire.push(m));
    await new Promise((r) => setTimeout(r, 0));
    handle.cancel();
    expect(wire.at(-1)).toEqual({ type: 'auth_login_done', provider: 'codex', ok: false, cancelled: true });
    expect(rpc.close).toHaveBeenCalled();
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
    expect(wire.at(-1)).toMatchObject({ type: 'auth_login_done', provider: 'codex', ok: false, error: 'boom' });
  });
});
