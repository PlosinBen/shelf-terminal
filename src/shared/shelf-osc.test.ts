import { describe, expect, it } from 'vitest';
import {
  SHELF_OSC_BEL,
  SHELF_OSC_ST,
  ShelfOscRouter,
  encodeShelfOscFrame,
  type ShelfOscFrame,
} from './shelf-osc';

describe('ShelfOscRouter', () => {
  const consume = () => true;

  it('routes a frame fragmented across prefix, payload, and terminator', () => {
    const router = new ShelfOscRouter();
    const frame = encodeShelfOscFrame('terminal-init', 1, 'YWJj');
    const received: ShelfOscFrame[] = [];
    const handlers = { 'terminal-init': (value: ShelfOscFrame) => { received.push(value); return true; } };

    expect(router.push(`prompt${frame.slice(0, 6)}`, handlers).visible).toBe('prompt');
    expect(router.push(frame.slice(6, -1), handlers).visible).toBe('');
    expect(router.push(`${frame.slice(-1)}ready`, handlers).visible).toBe('ready');
    expect(received).toEqual([{ route: 'terminal-init', version: 1, payload: 'YWJj', raw: frame }]);
  });

  it('routes multiple features and both BEL/ST terminators in one chunk', () => {
    const router = new ShelfOscRouter();
    const external = encodeShelfOscFrame('external-url', 1, 'aHR0cHM6Ly9leGFtcGxlLmNvbQ', SHELF_OSC_ST);
    const terminal = encodeShelfOscFrame('terminal-init', 1, 'e30', SHELF_OSC_BEL);
    const routes: string[] = [];
    const handlers = {
      'external-url': (frame: ShelfOscFrame) => { routes.push(frame.route); return true; },
      'terminal-init': (frame: ShelfOscFrame) => { routes.push(frame.route); return true; },
    };

    expect(router.push(`a${external}b${terminal}c`, handlers)).toEqual({
      visible: 'abc',
      anomalies: [],
    });
    expect(routes).toEqual(['external-url', 'terminal-init']);
  });

  it('passes unknown routes and handler-rejected versions through byte-for-byte', () => {
    const router = new ShelfOscRouter();
    const unknown = encodeShelfOscFrame('future-route', 1, 'YWJj');
    const futureVersion = encodeShelfOscFrame('terminal-init', 99, 'e30', SHELF_OSC_ST);

    expect(router.push(`${unknown}${futureVersion}`, {
      'terminal-init': (frame) => frame.version === 1,
    }).visible).toBe(`${unknown}${futureVersion}`);
  });

  it('preserves unrelated and malformed OSC input unchanged', () => {
    const router = new ShelfOscRouter();
    const input = `\x1b]0;title\x07${'\x1b]6973;missing-fields\x07'}prompt`;
    expect(router.push(input, { 'terminal-init': consume }).visible).toBe(input);
  });

  it('bounds oversized registered frames without reflecting their payload', () => {
    const router = new ShelfOscRouter();
    const oversized = `\x1b]6973;terminal-init;1;${'A'.repeat(20_000)}\x07`;
    const result = router.push(`${oversized}visible`, { 'terminal-init': consume });

    expect(result.visible).toBe('visible');
    expect(result.anomalies).toEqual([{ kind: 'frame-too-long', route: 'terminal-init' }]);
  });

  it('reports an unterminated registered frame but flushes an unrelated partial prefix', () => {
    const router = new ShelfOscRouter();
    router.push('\x1b]6973;terminal-init;1;AAAA', { 'terminal-init': consume });
    expect(router.finish({ 'terminal-init': consume })).toEqual({
      visible: '',
      anomalies: [{ kind: 'unterminated-frame', route: 'terminal-init' }],
    });

    const other = new ShelfOscRouter();
    other.push('text\x1b]69', {});
    expect(other.finish({})).toEqual({ visible: '\x1b]69', anomalies: [] });
  });
});
