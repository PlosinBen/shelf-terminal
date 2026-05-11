import { describe, it, expect, beforeEach, vi } from 'vitest';
import { log, setFileWriter, setLogLevel } from './logger';

describe('logger trace buffer', () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    setFileWriter((line) => written.push(line));
    setLogLevel('error');
    // Drain shared module-level buffer left over from any prior test.
    log.flushTrace('test-setup', 'reset');
    written.length = 0;
  });

  it('trace() does not write through file/console until flush', () => {
    log.trace('x', 'should-not-appear-yet');
    expect(written).toEqual([]);
  });

  it('flushTrace() emits all buffered entries plus a header', () => {
    log.trace('x', 'first');
    log.trace('y', 'second');
    log.flushTrace('caller', 'spawn ENOENT');

    expect(written.length).toBe(3);
    expect(written[0]).toMatch(/\[ERROR\]\[caller\] flushTrace: 2 entries follow \(reason: spawn ENOENT\)/);
    expect(written[1]).toMatch(/\[TRACE\]\[x\] first/);
    expect(written[2]).toMatch(/\[TRACE\]\[y\] second/);
  });

  it('flushTrace() with empty buffer still emits an error so caller sees something', () => {
    log.flushTrace('caller', 'nothing happened');
    expect(written.length).toBe(1);
    expect(written[0]).toMatch(/flushTrace: no entries/);
  });

  it('flushTrace() drains the buffer (second flush is empty)', () => {
    log.trace('x', 'a');
    log.flushTrace('caller', 'first');
    written.length = 0;

    log.flushTrace('caller', 'second');
    expect(written.length).toBe(1);
    expect(written[0]).toMatch(/no entries/);
  });

  it('trace ring buffer caps at 200 — oldest entries drop', () => {
    for (let i = 0; i < 250; i++) {
      log.trace('x', `entry-${i}`);
    }
    log.flushTrace('caller', 'overflow check');

    // 1 header + 200 entries
    expect(written.length).toBe(201);
    expect(written[1]).toMatch(/entry-50$/);
    expect(written[200]).toMatch(/entry-249$/);
  });
});
