import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { CODEX_OFFICAL_PROVIDER } from '@shared/agent-providers';
import { createCodexOfficialBackend } from './index';
import type { LoginRpc } from '../codex-shared/app-server-login';
import type { OutgoingMessage } from '../types';

function fakeRpc(): LoginRpc & { fireCompleted: (success: boolean) => void } {
  const notif = new Map<string, (p: unknown) => void>();
  return {
    async request<T>(method: string): Promise<T> {
      if (method === 'initialize') return {} as T;
      if (method === 'account/login/start') {
        return {
          type: 'chatgptDeviceCode',
          loginId: 'login-1',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-1234',
        } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
    onNotification(method, handler) { notif.set(method, handler); },
    close: vi.fn(),
    fireCompleted(success: boolean) { notif.get('account/login/completed')?.({ success }); },
  };
}

describe('Codex official SDK backend skeleton', () => {
  it('rejects real turns visibly until the Phase 2 lifecycle lands, then idles', async () => {
    const backend = createCodexOfficialBackend();
    const out: OutgoingMessage[] = [];
    await backend.query({ prompt: 'hi', cwd: '/repo' }, (m) => out.push(m));

    expect(out[0]).toMatchObject({ type: 'error', error: expect.stringMatching(/not implemented/) });
    expect(out.at(-1)).toEqual({ type: 'status', state: 'idle' });
  });

  it('reports the reduced SDK capability surface with current saved intent', async () => {
    const backend = createCodexOfficialBackend();
    const caps = await backend.gatherCapabilities!(
      '/repo',
      undefined,
      [{ id: 'custom-model' }],
      { model: 'custom-model', effort: 'minimal', permissionMode: 'plan' },
    );

    expect(caps.models.map((m) => m.value)).toContain('custom-model');
    expect(caps.effortLevels.map((e) => e.value)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(caps.permissionModes.map((p) => p.value)).toEqual(['default', 'plan', 'bypassPermissions']);
    expect(caps.slashCommands).toEqual([]);
    expect((caps as unknown as Record<string, unknown>).currentModel).toBe('custom-model');
    expect((caps as unknown as Record<string, unknown>).currentEffort).toBe('minimal');
    expect((caps as unknown as Record<string, unknown>).currentPermissionMode).toBe('plan');
  });

  it('declares isolated config home and SDK HOME-scoped skill target', () => {
    const backend = createCodexOfficialBackend();
    expect(backend.configHome!('app-1')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex'));
    expect(backend.skillTarget!('app-1')).toBe(path.join(os.homedir(), '.shelf', 'apps', 'app-1', 'codex-sdk-home', '.agents', 'skills'));
    expect(backend.configHome!(undefined)).toBeUndefined();
    expect(backend.skillTarget!(undefined)).toBeUndefined();
  });

  it('stamps auth events with the temporary provider id', async () => {
    const rpc = fakeRpc();
    const backend = createCodexOfficialBackend({ spawnLoginRpc: () => ({ rpc }) });
    const out: OutgoingMessage[] = [];
    backend.startLogin!('/repo', (m) => out.push(m));
    await new Promise((resolve) => setTimeout(resolve, 0));
    rpc.fireCompleted(true);

    expect(out[0]).toMatchObject({ type: 'auth_login_prompt', provider: CODEX_OFFICAL_PROVIDER });
    expect(out.at(-1)).toEqual({ type: 'auth_login_done', provider: CODEX_OFFICAL_PROVIDER, ok: true });
  });
});
