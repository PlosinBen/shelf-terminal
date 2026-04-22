import { describe, it, expect, beforeEach } from 'vitest';
import { append, read, remove, clear, allTabIds, has, stripAnsi } from './scrollback-buffer';

beforeEach(() => {
  clear();
});

describe('scrollback-buffer', () => {
  it('stores and reads data', () => {
    append('t1', 'hello\nworld\n');
    expect(read('t1', 10)).toBe('hello\nworld\n');
  });

  it('returns last N lines', () => {
    append('t1', 'a\nb\nc\nd\ne\n');
    expect(read('t1', 2)).toBe('e\n');
  });

  it('strips ANSI escape sequences', () => {
    append('t1', '\x1b[32mgreen\x1b[0m text\n');
    expect(read('t1', 10)).toBe('green text\n');
  });

  it('caps at MAX_BYTES', () => {
    const big = 'x'.repeat(120 * 1024);
    append('t1', big);
    const result = read('t1', 999999);
    expect(result.length).toBeLessThanOrEqual(100 * 1024);
  });

  it('remove deletes buffer', () => {
    append('t1', 'data');
    expect(has('t1')).toBe(true);
    remove('t1');
    expect(has('t1')).toBe(false);
    expect(read('t1', 10)).toBe('');
  });

  it('allTabIds returns known tabs', () => {
    append('t1', 'a');
    append('t2', 'b');
    expect(allTabIds().sort()).toEqual(['t1', 't2']);
  });

  it('clear removes all', () => {
    append('t1', 'a');
    append('t2', 'b');
    clear();
    expect(allTabIds()).toEqual([]);
  });
});

describe('stripAnsi', () => {
  it('strips color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text');
  });

  it('strips carriage returns', () => {
    expect(stripAnsi('line1\r\nline2')).toBe('line1\nline2');
  });
});
