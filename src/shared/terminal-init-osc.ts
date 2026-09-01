import { encodeShelfOscFrame, type ShelfOscFrame } from './shelf-osc';

export const TERMINAL_INIT_OSC_ROUTE = 'terminal-init';
export const TERMINAL_INIT_OSC_VERSION = 1;
export const TERMINAL_INIT_OSC_MAX_PAYLOAD = 1024;

export const TERMINAL_INIT_PHASE = {
  runner: 'runner',
  initScript: 'init-script',
} as const;

export type TerminalInitPhase = typeof TERMINAL_INIT_PHASE[keyof typeof TERMINAL_INIT_PHASE];

export const TERMINAL_INIT_RESULT = {
  ready: 'ready',
  isolationUnconfirmed: 'isolation-unconfirmed',
  success: 'success',
  failure: 'failure',
  cancelled: 'cancelled',
} as const;

export type TerminalInitResult = typeof TERMINAL_INIT_RESULT[keyof typeof TERMINAL_INIT_RESULT];

export interface TerminalInitPayload {
  readonly nonce: string;
  readonly phase: TerminalInitPhase;
  readonly result: TerminalInitResult;
}

export interface TerminalInitTokens {
  readonly runnerReady: string;
  readonly runnerIsolationUnconfirmed: string;
  readonly initScriptSuccess: string;
  readonly initScriptFailure: string;
  readonly initScriptCancelled: string;
}

export type TerminalInitDecodeResult =
  | { readonly ok: true; readonly payload: TerminalInitPayload }
  | {
    readonly ok: false;
    readonly reason:
      | 'unsupported-version'
      | 'invalid-payload'
      | 'nonce-mismatch'
      | 'unexpected-phase';
  };

export function createTerminalInitTokens(nonce: string): TerminalInitTokens {
  return Object.freeze({
    runnerReady: encodePayload({
      nonce, phase: TERMINAL_INIT_PHASE.runner, result: TERMINAL_INIT_RESULT.ready,
    }),
    runnerIsolationUnconfirmed: encodePayload({
      nonce, phase: TERMINAL_INIT_PHASE.runner, result: TERMINAL_INIT_RESULT.isolationUnconfirmed,
    }),
    initScriptSuccess: encodePayload({
      nonce, phase: TERMINAL_INIT_PHASE.initScript, result: TERMINAL_INIT_RESULT.success,
    }),
    initScriptFailure: encodePayload({
      nonce, phase: TERMINAL_INIT_PHASE.initScript, result: TERMINAL_INIT_RESULT.failure,
    }),
    initScriptCancelled: encodePayload({
      nonce, phase: TERMINAL_INIT_PHASE.initScript, result: TERMINAL_INIT_RESULT.cancelled,
    }),
  });
}

export function encodeTerminalInitFrame(payload: TerminalInitPayload): string {
  return encodeShelfOscFrame(TERMINAL_INIT_OSC_ROUTE, TERMINAL_INIT_OSC_VERSION, encodePayload(payload));
}

export function decodeTerminalInitFrame(
  frame: ShelfOscFrame,
  expectedNonce: string,
  expectedPhase: TerminalInitPhase,
): TerminalInitDecodeResult {
  if (frame.route !== TERMINAL_INIT_OSC_ROUTE || frame.version !== TERMINAL_INIT_OSC_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  const payload = decodePayload(frame.payload);
  if (!payload) return { ok: false, reason: 'invalid-payload' };
  if (payload.nonce !== expectedNonce) return { ok: false, reason: 'nonce-mismatch' };
  if (payload.phase !== expectedPhase) return { ok: false, reason: 'unexpected-phase' };
  return { ok: true, payload };
}

function encodePayload(payload: TerminalInitPayload): string {
  return encodeBase64Url(JSON.stringify(payload));
}

function decodePayload(encoded: string): TerminalInitPayload | null {
  if (!encoded || encoded.length > TERMINAL_INIT_OSC_MAX_PAYLOAD || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return null;
  }
  try {
    const decoded = decodeBase64Url(encoded);
    if (decoded === null || encodeBase64Url(decoded) !== encoded) return null;
    const value: unknown = JSON.parse(decoded);
    if (!isTerminalInitPayload(value)) return null;
    return Object.freeze({ ...value });
  } catch {
    return null;
  }
}

function isTerminalInitPayload(value: unknown): value is TerminalInitPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'nonce,phase,result') return false;
  if (typeof record.nonce !== 'string'
    || record.nonce.length === 0
    || record.nonce.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(record.nonce)) return false;
  if (record.phase === TERMINAL_INIT_PHASE.runner) {
    return record.result === TERMINAL_INIT_RESULT.ready
      || record.result === TERMINAL_INIT_RESULT.isolationUnconfirmed;
  }
  if (record.phase === TERMINAL_INIT_PHASE.initScript) {
    return record.result === TERMINAL_INIT_RESULT.success
      || record.result === TERMINAL_INIT_RESULT.failure
      || record.result === TERMINAL_INIT_RESULT.cancelled;
  }
  return false;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
