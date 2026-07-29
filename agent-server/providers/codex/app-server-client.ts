import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { resolveCodexCliCommand } from '../codex-shared/runtime';
import { serverLog } from '../../server-logger';

export const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;

export interface CodexAppServerProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export interface CodexAppServerClientOptions {
  process: CodexAppServerProcess;
  requestTimeoutMs?: number;
  onError?: (error: Error) => void;
}

export type CodexAppServerNotificationHandler = (params: unknown) => void;
export type CodexAppServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export class CodexAppServerClient {
  private readonly rl: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, CodexAppServerNotificationHandler>();
  private readonly requestHandlers = new Map<string, CodexAppServerRequestHandler>();
  private readonly requestTimeoutMs: number;
  private nextId = 0;
  private closed = false;

  constructor(private readonly opts: CodexAppServerClientOptions) {
    if (!opts.process.stdin || !opts.process.stdout) {
      throw new Error('codex app-server process must expose stdin and stdout');
    }
    this.requestTimeoutMs = opts.requestTimeoutMs ?? CODEX_APP_SERVER_REQUEST_TIMEOUT_MS;
    this.rl = readline.createInterface({ input: opts.process.stdout });
    this.rl.on('line', (line) => this.handleLine(line));
    opts.process.on('exit', (code, signal) => {
      this.failAll(new Error(`codex app-server exited before pending requests completed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
      this.closeReadline();
    });
    opts.process.on('error', (err) => {
      this.failAll(new Error(`codex app-server spawn error: ${redactCodexAppServerText(err.message)}`));
      this.reportError(err);
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`codex app-server request after close: ${method}`));
    const stdin = this.opts.process.stdin;
    if (!stdin) return Promise.reject(new Error(`codex app-server stdin unavailable for ${method}`));
    const id = ++this.nextId;
    const envelope = params === undefined
      ? { jsonrpc: '2.0', id, method }
      : { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = this.requestTimeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`codex app-server request timed out: ${method}`));
          }, this.requestTimeoutMs)
        : null;
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        stdin.write(`${JSON.stringify(envelope)}\n`);
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error(`codex app-server write failed for ${method}: ${redactCodexAppServerText((err as Error)?.message ?? String(err))}`));
      }
    });
  }

  onNotification(method: string, handler: CodexAppServerNotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onRequest(method: string, handler: CodexAppServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReadline();
    this.failAll(new Error('codex app-server client closed'));
    try { this.opts.process.kill(); } catch { /* noop */ }
  }

  private handleLine(line: string): void {
    let envelope: JsonRpcEnvelope;
    try {
      envelope = JSON.parse(line) as JsonRpcEnvelope;
    } catch {
      this.reportError(new Error(`codex app-server emitted malformed JSON: ${redactCodexAppServerText(line.slice(0, 300))}`));
      return;
    }

    if (typeof envelope.id === 'number' && (Object.prototype.hasOwnProperty.call(envelope, 'result') || Object.prototype.hasOwnProperty.call(envelope, 'error'))) {
      this.handleResponse(envelope.id, envelope);
      return;
    }
    if (typeof envelope.id === 'number' && typeof envelope.method === 'string') {
      void this.handleServerRequest(envelope.id, envelope.method, envelope.params);
      return;
    }
    if (typeof envelope.method === 'string') {
      this.notificationHandlers.get(envelope.method)?.(envelope.params);
      return;
    }
    this.reportError(new Error(`codex app-server emitted unsupported envelope: ${redactCodexAppServerText(JSON.stringify(envelope).slice(0, 300))}`));
  }

  private handleResponse(id: number, envelope: JsonRpcEnvelope): void {
    const pending = this.pending.get(id);
    if (!pending) {
      this.reportError(new Error(`codex app-server response for unknown request id: ${id}`));
      return;
    }
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (envelope.error) {
      pending.reject(new Error(`codex app-server ${pending.method} failed: ${redactCodexAppServerText(formatJson(envelope.error))}`));
    } else {
      pending.resolve(envelope.result);
    }
  }

  private async handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.writeResponse({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported Codex app-server request: ${method}` } });
      this.reportError(new Error(`codex app-server requested unsupported method: ${method}`));
      return;
    }
    try {
      const result = await handler(params);
      this.writeResponse({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (err) {
      this.writeResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: redactCodexAppServerText((err as Error)?.message ?? String(err)) },
      });
    }
  }

  private writeResponse(envelope: Record<string, unknown>): void {
    try {
      this.opts.process.stdin?.write(`${JSON.stringify(envelope)}\n`);
    } catch (err) {
      this.reportError(new Error(`codex app-server response write failed: ${redactCodexAppServerText((err as Error)?.message ?? String(err))}`));
    }
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private closeReadline(): void {
    try { this.rl.close(); } catch { /* noop */ }
  }

  private reportError(error: Error): void {
    const redacted = new Error(redactCodexAppServerText(error.message));
    this.opts.onError?.(redacted);
    serverLog('warn', 'codex-app-server', redacted.message);
  }
}

export function spawnCodexAppServerClient(
  env: NodeJS.ProcessEnv = process.env,
  opts: Omit<CodexAppServerClientOptions, 'process'> = {},
): { client: CodexAppServerClient; child: ChildProcess } {
  const { command, args } = resolveCodexCliCommand();
  const child = spawn(command, [...args, 'app-server'], { stdio: ['pipe', 'pipe', 'inherit'], env });
  return { child, client: new CodexAppServerClient({ ...opts, process: child }) };
}

export function redactCodexAppServerText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted-email>')
    .replace(/\b(?:access|refresh|id)_token["'=:\s]+[A-Za-z0-9._~+/=-]+/gi, '<redacted-token>')
    .replace(/\b(?:account|org|organization|user|workspace)[_-]?id["'=:\s]+[A-Za-z0-9._:-]+/gi, '<redacted-id>');
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable]';
  }
}
