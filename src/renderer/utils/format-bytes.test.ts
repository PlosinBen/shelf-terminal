import { describe, it, expect } from 'vitest';
import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it('0 → "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('small bytes round to nearest integer', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('crosses to KB at 1024', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2048)).toBe('2.0 KB');
    // 12.4 KB (not 12.5 KB) — toFixed rounds banker-style; this is just to
    // pin down the chosen decimal place.
    expect(formatBytes(12.4 * 1024)).toBe('12.4 KB');
  });

  it('crosses to MB at 1024^2', () => {
    expect(formatBytes(1024 ** 2)).toBe('1.0 MB');
    expect(formatBytes(12.4 * 1024 ** 2)).toBe('12.4 MB');
    expect(formatBytes(1024 ** 3 - 1)).toMatch(/^\d+(\.\d)? MB$/);
  });

  it('crosses to GB at 1024^3, uses 2 decimals', () => {
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB');
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.50 GB');
    expect(formatBytes(1.23 * 1024 ** 3)).toBe('1.23 GB');
  });

  it('non-finite / negative inputs clamp to "0 B"', () => {
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(Infinity)).toBe('0 B');
    expect(formatBytes(-Infinity)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(-1024)).toBe('0 B');
  });
});
