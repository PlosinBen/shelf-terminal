// Codex device-code login DRIVE (shared by legacy ACP and official SDK transports).

import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import type { SendFn } from '../types';
import { deviceCodeToAuthPrompt, authLoginDone } from './auth';
import { resolveCodexCliCommand } from './runtime';

/** Minimal JSON-RPC client the login drive needs. */
export interface LoginRpc {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  onNotification(method: string, handler: (params: unknown) => void): void;
  close(): void;
}

interface DeviceCodeStartResponse {
  type: 'chatgptDeviceCode';
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface LoginHandle {
  cancel(): void;
}

/**
 * Drive the device-code login over `rpc`, emitting `auth_login_prompt` (URL +
 * code) then `auth_login_done` on completion/failure. Returns a handle whose
 * `cancel()` tears down the transport.
 */
export function driveDeviceCodeLogin(rpc: LoginRpc, emit: SendFn, provider = 'codex'): LoginHandle {
  let settled = false;
  const done = (ok: boolean, opts?: { cancelled?: boolean; error?: string }) => {
    if (settled) return;
    settled = true;
    emit(authLoginDone(ok, { provider, ...opts }));
    rpc.close();
  };

  rpc.onNotification('account/login/completed', (params) => {
    const success = !!(params as { success?: boolean } | undefined)?.success;
    done(success, success ? undefined : { error: 'login not completed' });
  });

  (async () => {
    await rpc.request('initialize', {
      capabilities: null,
      clientInfo: { name: 'shelf', version: '0.0.0', title: 'Shelf' },
    });
    const res = await rpc.request<DeviceCodeStartResponse>('account/login/start', { type: 'chatgptDeviceCode' });
    emit(deviceCodeToAuthPrompt({ verificationUrl: res.verificationUrl, userCode: res.userCode }, provider));
  })().catch((err) => {
    done(false, { error: (err as Error)?.message ?? String(err) });
  });

  return {
    cancel() {
      if (settled) return;
      settled = true;
      emit(authLoginDone(false, { provider, cancelled: true }));
      rpc.close();
    },
  };
}

/** Production transport: spawn `codex app-server` and speak newline JSON-RPC. */
export function spawnCodexAppServerRpc(env: NodeJS.ProcessEnv = process.env): { rpc: LoginRpc; child: ChildProcess } {
  const { command, args } = resolveCodexCliCommand();
  // env carries CODEX_HOME so the device-code login writes auth to the per-app
  // config-home, matching the provider turn process.
  const child = spawn(command, [...args, 'app-server'], { stdio: ['pipe', 'pipe', 'inherit'], env });
  const rl = readline.createInterface({ input: child.stdout! });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const notifHandlers = new Map<string, (params: unknown) => void>();
  let idc = 0;

  rl.on('line', (line) => {
    let m: { id?: number; result?: unknown; error?: unknown; method?: string; params?: unknown };
    try { m = JSON.parse(line); } catch { return; }
    if (typeof m.id === 'number' && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    } else if (m.method) {
      notifHandlers.get(m.method)?.(m.params);
    }
  });

  const rpc: LoginRpc = {
    request<T>(method: string, params?: unknown): Promise<T> {
      const id = ++idc;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    onNotification(method, handler) { notifHandlers.set(method, handler); },
    close() { try { rl.close(); } catch { /* noop */ } try { child.kill(); } catch { /* noop */ } },
  };
  return { rpc, child };
}
