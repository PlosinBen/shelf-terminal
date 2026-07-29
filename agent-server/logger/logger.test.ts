import { describe, it, expect, vi, afterEach } from 'vitest';
import { wireLogger } from './wire';
import { rawLogger } from './raw';
import { setWireSink, type WireLogMessage } from './core';

afterEach(() => {
  // Reset the sink between tests (pre-wire fallback path).
  setWireSink(undefined as unknown as (m: WireLogMessage) => void);
  vi.restoreAllMocks();
});

describe('wireLogger', () => {
  it('emits a {type:log} record to the injected sink, no channel by default', () => {
    const sink = vi.fn();
    setWireSink(sink);
    wireLogger.info('copilot', 'hello');
    expect(sink).toHaveBeenCalledWith({
      type: 'log',
      level: 'info',
      tag: 'copilot',
      msg: 'hello',
      channel: undefined,
    });
  });

  it('.channel(name) stamps the channel; the transport stays wire', () => {
    const sink = vi.fn();
    setWireSink(sink);
    wireLogger.channel('feature-trace').debug('worker', 'phase complete');
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'log', level: 'debug', tag: 'worker', msg: 'phase complete', channel: 'feature-trace' }),
    );
  });

  it('flattens extra args to text (Error → stack, object → JSON)', () => {
    const sink = vi.fn();
    setWireSink(sink);
    wireLogger.warn('exec', 'failed', new Error('boom'), { a: 1 });
    const m = sink.mock.calls[0][0] as WireLogMessage;
    expect(m.msg).toContain('failed');
    expect(m.msg).toContain('boom'); // Error stack/message survived
    expect(m.msg).toContain('{"a":1}');
  });

  it('falls back to stderr before a sink is wired (nothing lost)', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    wireLogger.error('copilot', 'pre-wire');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('[error][copilot] pre-wire');
  });
});

describe('rawLogger', () => {
  it('writes straight to stderr (never the wire sink)', () => {
    const sink = vi.fn();
    setWireSink(sink);
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    rawLogger.error('exec', 'no ping — self-exiting');
    expect(sink).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('[error][exec] no ping — self-exiting');
  });

  it('has no channel method (stderr has no files)', () => {
    expect((rawLogger as unknown as { channel?: unknown }).channel).toBeUndefined();
  });
});
