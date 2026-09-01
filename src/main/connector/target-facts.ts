import { randomBytes } from 'crypto';
import type { ConnectorRuntime } from './runtime';

const TARGET_FACTS_FRAME = '__SHELF_TARGET_FACTS_V1__';
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024;

export const TARGET_OS = {
  unix: 'unix',
  windows: 'windows',
} as const;

export type TargetOS = typeof TARGET_OS[keyof typeof TARGET_OS];

export interface TargetFacts {
  readonly targetOS: TargetOS;
  readonly defaultShell: string;
}

export interface TargetFactsAttemptFailure {
  readonly candidate: 'posix' | 'powershell';
  readonly category: 'exec-error' | 'invalid-output';
  readonly detail: string;
}

export type TargetFactsResult =
  | { readonly ok: true; readonly facts: TargetFacts }
  | {
    readonly ok: false;
    readonly reason: 'probe-failed' | 'generation-invalidated';
    readonly attempts: readonly TargetFactsAttemptFailure[];
  };

interface ResolverOptions {
  nonce?: () => string;
}

interface ProbeCandidate {
  readonly name: TargetFactsAttemptFailure['candidate'];
  command(nonce: string): string;
}

const CANDIDATES: readonly ProbeCandidate[] = [
  { name: 'posix', command: buildPosixProbe },
  { name: 'powershell', command: buildPowerShellProbe },
];

export function encodeTargetFactsFrame(nonce: string, facts: TargetFacts): string {
  const payload = Buffer.from(JSON.stringify(facts), 'utf8').toString('base64url');
  return `${TARGET_FACTS_FRAME}:${nonce}:${payload}`;
}

/** Independent, generation-scoped target fact resolver used only by terminals. */
export class TargetFactsResolver {
  private readonly probes = new WeakMap<ConnectorRuntime, Promise<TargetFactsResult>>();
  private readonly makeNonce: () => string;

  constructor(options: ResolverOptions = {}) {
    this.makeNonce = options.nonce ?? (() => randomBytes(18).toString('base64url'));
  }

  resolve(
    runtime: ConnectorRuntime,
    signal?: AbortSignal,
    cwd = '.',
  ): Promise<TargetFactsResult> {
    let shared = this.probes.get(runtime);
    if (!shared) {
      shared = this.probe(runtime, cwd);
      this.probes.set(runtime, shared);
    }
    return signal ? waitForSharedProbe(shared, signal) : shared;
  }

  private async probe(runtime: ConnectorRuntime, cwd: string): Promise<TargetFactsResult> {
    const nonce = this.makeNonce();
    const attempts: TargetFactsAttemptFailure[] = [];

    for (const candidate of CANDIDATES) {
      if (!runtime.isCurrentGeneration()) return invalidated(attempts);
      try {
        const result = await runtime.exec(cwd, candidate.command(nonce));
        if (!runtime.isCurrentGeneration()) return invalidated(attempts);
        const parsed = parseTargetFactsFrame(result.stdout, nonce);
        if (parsed.ok) return parsed;
        attempts.push({
          candidate: candidate.name,
          category: 'invalid-output',
          detail: parsed.detail,
        });
      } catch (error) {
        if (!runtime.isCurrentGeneration()) return invalidated(attempts);
        attempts.push({
          candidate: candidate.name,
          category: 'exec-error',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return Object.freeze({
      ok: false,
      reason: 'probe-failed',
      attempts: Object.freeze(attempts),
    });
  }
}

function invalidated(attempts: TargetFactsAttemptFailure[]): TargetFactsResult {
  return Object.freeze({
    ok: false,
    reason: 'generation-invalidated',
    attempts: Object.freeze([...attempts]),
  });
}

function waitForSharedProbe(
  shared: Promise<TargetFactsResult>,
  signal: AbortSignal,
): Promise<TargetFactsResult> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error('Target-facts wait was cancelled');
  error.name = 'AbortError';
  return error;
}

function parseTargetFactsFrame(
  stdout: string,
  expectedNonce: string,
): { ok: true; facts: TargetFacts } | { ok: false; detail: string } {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
    return { ok: false, detail: 'stdout exceeded limit' };
  }

  const protocolLines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(TARGET_FACTS_FRAME));
  if (protocolLines.length !== 1) {
    return { ok: false, detail: `expected one frame, received ${protocolLines.length}` };
  }

  const match = protocolLines[0].match(
    /^__SHELF_TARGET_FACTS_V1__:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)\s*$/,
  );
  if (!match) return { ok: false, detail: 'malformed frame' };
  if (match[1] !== expectedNonce) return { ok: false, detail: 'nonce mismatch' };

  let decoded: Buffer;
  try {
    decoded = Buffer.from(match[2], 'base64url');
  } catch {
    return { ok: false, detail: 'malformed payload encoding' };
  }
  if (decoded.length === 0 || decoded.length > MAX_PAYLOAD_BYTES) {
    return { ok: false, detail: 'payload size outside limit' };
  }

  try {
    const value: unknown = JSON.parse(decoded.toString('utf8'));
    if (!isTargetFacts(value)) return { ok: false, detail: 'invalid target facts schema' };
    return { ok: true, facts: Object.freeze({ ...value }) };
  } catch {
    return { ok: false, detail: 'malformed payload JSON' };
  }
}

function isTargetFacts(value: unknown): value is TargetFacts {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) return false;
  if (record.targetOS === TARGET_OS.unix) {
    return typeof record.defaultShell === 'string'
      && record.defaultShell.length <= 512
      && /^\/[A-Za-z0-9_./+-]+$/.test(record.defaultShell);
  }
  if (record.targetOS === TARGET_OS.windows) {
    return record.defaultShell === 'powershell.exe';
  }
  return false;
}

function buildPosixProbe(nonce: string): string {
  return [
    '_shelf_os=$(uname -s 2>/dev/null) || exit 31',
    'case "$_shelf_os" in Linux|Darwin|FreeBSD|OpenBSD|NetBSD|SunOS) ;; *) exit 32 ;; esac',
    '_shelf_shell=${SHELL:-}',
    'case "$_shelf_shell" in /*) ;; *) exit 33 ;; esac',
    'case "$_shelf_shell" in *[!A-Za-z0-9_./+-]*) exit 34 ;; esac',
    `_shelf_payload=$(printf '{"targetOS":"unix","defaultShell":"%s"}' "$_shelf_shell" | base64 | tr -d '\\r\\n' | tr '+/' '-_' | tr -d '=') || exit 35`,
    `printf '\\n${TARGET_FACTS_FRAME}:${nonce}:%s\\n' "$_shelf_payload"`,
  ].join('; ');
}

function buildPowerShellProbe(nonce: string): string {
  const script = [
    "$ErrorActionPreference='Stop'",
    "if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { exit 41 }",
    "$json='{" + '"targetOS":"windows","defaultShell":"powershell.exe"' + "}'",
    "$payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+','-').Replace('/','_')",
    `[Console]::Out.WriteLine('${TARGET_FACTS_FRAME}:${nonce}:' + $payload)`,
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}
