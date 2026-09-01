import { describe, expect, it } from 'vitest';
import { ShelfOscRouter } from './shelf-osc';
import {
  TERMINAL_INIT_PHASE,
  TERMINAL_INIT_RESULT,
  createTerminalInitTokens,
  decodeTerminalInitFrame,
  encodeTerminalInitFrame,
} from './terminal-init-osc';

describe('terminal-init OSC protocol', () => {
  it('encodes the whole semantic JSON payload and validates it on decode', () => {
    const nonce = 'session_nonce-1';
    const frame = encodeTerminalInitFrame({
      nonce,
      phase: TERMINAL_INIT_PHASE.runner,
      result: TERMINAL_INIT_RESULT.ready,
    });
    const router = new ShelfOscRouter();
    let decoded: ReturnType<typeof decodeTerminalInitFrame> | undefined;

    expect(router.push(frame, {
      'terminal-init': (value) => {
        decoded = decodeTerminalInitFrame(value, nonce, TERMINAL_INIT_PHASE.runner);
        return true;
      },
    }).visible).toBe('');
    expect(decoded).toEqual({
      ok: true,
      payload: { nonce, phase: 'runner', result: 'ready' },
    });
  });

  it('precomputes opaque tokens for every allowed runner event', () => {
    const tokens = createTerminalInitTokens('fixed_nonce');

    expect(tokens.runnerReady).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokens.runnerIsolationUnconfirmed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokens.initScriptSuccess).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokens.initScriptFailure).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokens.initScriptCancelled).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['nonce-mismatch', 'other_nonce', TERMINAL_INIT_PHASE.runner],
    ['unexpected-phase', 'fixed_nonce', TERMINAL_INIT_PHASE.initScript],
  ] as const)('rejects %s without accepting the transition', (_name, expectedNonce, expectedPhase) => {
    const frame = encodeTerminalInitFrame({
      nonce: 'fixed_nonce',
      phase: TERMINAL_INIT_PHASE.runner,
      result: TERMINAL_INIT_RESULT.ready,
    });
    const router = new ShelfOscRouter();
    let decoded: ReturnType<typeof decodeTerminalInitFrame> | undefined;
    router.push(frame, {
      'terminal-init': (value) => {
        decoded = decodeTerminalInitFrame(value, expectedNonce, expectedPhase);
        return true;
      },
    });
    expect(decoded?.ok).toBe(false);
  });

  it('rejects invalid phase/result combinations and non-canonical payloads', () => {
    const invalid = Buffer.from(JSON.stringify({
      nonce: 'fixed_nonce', phase: 'runner', result: 'success', extra: true,
    })).toString('base64url');
    const router = new ShelfOscRouter();
    let decoded: ReturnType<typeof decodeTerminalInitFrame> | undefined;
    router.push(`\x1b]6973;terminal-init;1;${invalid}\x07`, {
      'terminal-init': (value) => {
        decoded = decodeTerminalInitFrame(value, 'fixed_nonce', TERMINAL_INIT_PHASE.runner);
        return true;
      },
    });
    expect(decoded).toEqual({ ok: false, reason: 'invalid-payload' });
  });

  it('returns unsupported-version so the phase-aware caller can pass raw bytes through', () => {
    const router = new ShelfOscRouter();
    const raw = '\x1b]6973;terminal-init;2;e30\x07';
    let shouldConsume = true;
    const result = router.push(raw, {
      'terminal-init': (frame) => {
        const decoded = decodeTerminalInitFrame(frame, 'fixed_nonce', TERMINAL_INIT_PHASE.runner);
        shouldConsume = decoded.ok || decoded.reason !== 'unsupported-version';
        return shouldConsume;
      },
    });

    expect(shouldConsume).toBe(false);
    expect(result.visible).toBe(raw);
  });
});
