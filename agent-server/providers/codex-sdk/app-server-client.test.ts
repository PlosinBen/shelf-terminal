import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, redactCodexAppServerText, type CodexAppServerProcess } from './app-server-client';

class FakeCodexProcess extends EventEmitter implements CodexAppServerProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  writes: string[] = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk) => {
      this.writes.push(String(chunk));
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  send(line: unknown): void {
    this.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
  }

  lastWrite(): unknown {
    const raw = this.writes.at(-1);
    if (!raw) return undefined;
    return JSON.parse(raw.trim());
  }
}

function createHarness(opts: { timeoutMs?: number } = {}) {
  const proc = new FakeCodexProcess();
  const errors: string[] = [];
  const client = new CodexAppServerClient({
    process: proc,
    requestTimeoutMs: opts.timeoutMs ?? 1_000,
    onError: (err) => errors.push(err.message),
  });
  return { proc, client, errors };
}

async function tick(): Promise<void> {
  await Promise.resolve();
}

describe('CodexAppServerClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes JSON-RPC requests and resolves matching responses', async () => {
    const { proc, client } = createHarness();

    const promise = client.request('initialize', { clientInfo: { name: 'shelf' } });

    expect(proc.lastWrite()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'shelf' } },
    });

    proc.send({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('rejects JSON-RPC errors with redaction', async () => {
    const { proc, client } = createHarness();

    const promise = client.request('account/read');
    proc.send({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'failed for ben@example.com access_token: secret' },
    });

    await expect(promise).rejects.toThrow('<redacted-email>');
    await expect(promise).rejects.toThrow('<redacted-token>');
  });

  it('routes notifications by method without requiring a response id', async () => {
    const { proc, client } = createHarness();
    const handler = vi.fn();
    client.onNotification('thread/tokenUsage/updated', handler);

    proc.send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { totalTokens: 12 } } } });
    await tick();

    expect(handler).toHaveBeenCalledWith({ tokenUsage: { total: { totalTokens: 12 } } });
  });

  it('routes app-server requests and writes handler results', async () => {
    const { proc, client } = createHarness();
    client.onRequest('item/permissions/requestApproval', async (params) => {
      expect(params).toEqual({ reason: 'write' });
      return { decision: 'decline' };
    });

    proc.send({ jsonrpc: '2.0', id: 9, method: 'item/permissions/requestApproval', params: { reason: 'write' } });
    await tick();
    await tick();

    expect(proc.lastWrite()).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: { decision: 'decline' },
    });
  });

  it('responds fail-loud to unsupported app-server requests', async () => {
    const { proc, errors } = createHarness();

    proc.send({ jsonrpc: '2.0', id: 10, method: 'item/tool/call', params: {} });
    await tick();

    expect(proc.lastWrite()).toEqual({
      jsonrpc: '2.0',
      id: 10,
      error: { code: -32601, message: 'Unsupported Codex app-server request: item/tool/call' },
    });
    expect(errors).toContain('codex app-server requested unsupported method: item/tool/call');
  });

  it('reports malformed JSON and unknown response ids', async () => {
    const { proc, errors } = createHarness();

    proc.send('{"email":"ben@example.com"');
    proc.send({ jsonrpc: '2.0', id: 999, result: true });
    await tick();

    expect(errors[0]).toContain('malformed JSON');
    expect(errors[0]).toContain('<redacted-email>');
    expect(errors[1]).toBe('codex app-server response for unknown request id: 999');
  });

  it('rejects pending requests on process exit', async () => {
    const { proc, client } = createHarness();

    const promise = client.request('thread/start');
    proc.emit('exit', 7, null);

    await expect(promise).rejects.toThrow('code=7');
  });

  it('times out pending requests', async () => {
    const { client } = createHarness({ timeoutMs: 50 });

    const promise = client.request('thread/start');
    vi.advanceTimersByTime(50);

    await expect(promise).rejects.toThrow('timed out: thread/start');
  });

  it('closes the process and rejects later requests', async () => {
    const { proc, client } = createHarness();

    client.close();

    expect(proc.killed).toBe(true);
    await expect(client.request('model/list')).rejects.toThrow('request after close');
  });
});

describe('redactCodexAppServerText', () => {
  it('redacts account metadata and tokens', () => {
    const redacted = redactCodexAppServerText('ben@example.com refresh_token: secret account_id=acct_1');
    expect(redacted).toBe('<redacted-email> <redacted-token> <redacted-id>');
  });
});
