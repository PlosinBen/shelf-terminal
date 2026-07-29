import { describe, it, expect, vi, afterEach } from 'vitest';
import { channelLog, sanitizeChannel, setChannelWriter } from './channel-log';

afterEach(() => {
  setChannelWriter(() => {});
});

describe('sanitizeChannel', () => {
  it('keeps safe segments', () => {
    expect(sanitizeChannel('feature-trace')).toBe('feature-trace');
    expect(sanitizeChannel('wire_tx-2')).toBe('wire_tx-2');
  });
  it('neutralizes path traversal / odd chars', () => {
    expect(sanitizeChannel('../etc/passwd')).toBe('___etc_passwd');
    expect(sanitizeChannel('a/b')).toBe('a_b');
  });
  it('empty → unnamed', () => {
    expect(sanitizeChannel('')).toBe('unnamed');
    expect(sanitizeChannel('//')).toBe('unnamed');
  });
});

describe('channelLog', () => {
  it('formats a timestamped line and routes it to the (sanitized) channel', () => {
    const writer = vi.fn();
    setChannelWriter(writer);
    channelLog('feature-trace', 'debug', 'worker', 'phase complete');
    expect(writer).toHaveBeenCalledTimes(1);
    const [channel, line] = writer.mock.calls[0];
    expect(channel).toBe('feature-trace');
    expect(line).toContain('[DEBUG][worker] phase complete');
    expect(line).toMatch(/^\d{4}-\d\d-\d\dT/); // ISO timestamp prefix
  });

  it('sanitizes the channel before handing it to the writer', () => {
    const writer = vi.fn();
    setChannelWriter(writer);
    channelLog('a/b', 'info', 't', 'm');
    expect(writer.mock.calls[0][0]).toBe('a_b');
  });

  it('is a no-op when no writer is wired', () => {
    setChannelWriter(undefined as unknown as (c: string, l: string) => void);
    expect(() => channelLog('x', 'info', 't', 'm')).not.toThrow();
  });
});
