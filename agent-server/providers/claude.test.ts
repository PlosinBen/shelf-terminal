import { describe, it, expect, vi, afterEach } from 'vitest';
import { mergeClaudeModels, rateLimitInfoToSegment } from './claude';
import type { ProviderModel } from '../../src/shared/types';

describe('mergeClaudeModels', () => {
  it('returns SDK models unchanged when no customs', () => {
    const sdk = [
      { value: 'opus', displayName: 'Opus' },
      { value: 'sonnet', displayName: 'Sonnet' },
    ];
    const merged = mergeClaudeModels(sdk, []);
    expect(merged).toEqual([
      { value: 'opus', displayName: 'Opus', vision: true },
      { value: 'sonnet', displayName: 'Sonnet', vision: true },
    ]);
  });

  it('appends custom models that are not in SDK list', () => {
    const sdk = [{ value: 'opus', displayName: 'Opus' }];
    const customs: ProviderModel[] = [
      { id: 'claude-opus-4-6', contextWindow: 200_000 },
    ];
    const merged = mergeClaudeModels(sdk, customs);
    expect(merged).toEqual([
      { value: 'opus', displayName: 'Opus', vision: true },
      { value: 'claude-opus-4-6', displayName: 'claude-opus-4-6', vision: true },
    ]);
  });

  it('user custom overrides SDK entry of the same id', () => {
    const sdk = [{ value: 'opus', displayName: 'Opus' }];
    const customs: ProviderModel[] = [
      { id: 'opus', contextWindow: 1_000_000 },
    ];
    const merged = mergeClaudeModels(sdk, customs);
    expect(merged).toHaveLength(1);
    expect(merged[0].value).toBe('opus');
  });

  it('handles empty SDK list (only customs)', () => {
    const sdk: { value: string; displayName: string }[] = [];
    const customs: ProviderModel[] = [
      { id: 'claude-opus-4-7', contextWindow: 200_000 },
    ];
    const merged = mergeClaudeModels(sdk, customs);
    expect(merged).toEqual([
      { value: 'claude-opus-4-7', displayName: 'claude-opus-4-7', vision: true },
    ]);
  });

  it('handles undefined customs', () => {
    const sdk = [{ value: 'opus', displayName: 'Opus' }];
    const merged = mergeClaudeModels(sdk, undefined);
    expect(merged).toEqual([{ value: 'opus', displayName: 'Opus', vision: true }]);
  });
});

describe('rateLimitInfoToSegment', () => {
  // Pin "now" so resetsAt countdown formatting is deterministic.
  // Fixed at 2026-05-07 16:18 UTC; SDK's resetsAt is unix seconds.
  const FIXED_NOW_MS = Date.UTC(2026, 4, 7, 16, 18, 0);

  afterEach(() => {
    vi.useRealTimers();
  });

  function freezeNow() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW_MS));
  }

  // Regression: SDK only populates `utilization` when status crosses into
  // warning/rejected. On `allowed`, the field is absent — previous code
  // dropped the entire segment, hiding the bucket and reset countdown.
  it('renders segment without percent when utilization is absent', () => {
    freezeNow();
    const seg = rateLimitInfoToSegment({
      status: 'allowed',
      resetsAt: 1778181600, // 2026-05-07 19:20 UTC, ~3h ahead of FIXED_NOW
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      isUsingOverage: false,
    });
    expect(seg).not.toBeNull();
    expect(seg!.text).toBe('5h: — ↻3.0h');
    expect(seg!.severity).toBe('normal');
  });

  it('renders percent + countdown when utilization is present', () => {
    freezeNow();
    const seg = rateLimitInfoToSegment({
      status: 'allowed_warning',
      resetsAt: 1778181600,
      rateLimitType: 'five_hour',
      utilization: 0.62,
    });
    expect(seg!.text).toBe('5h: 62% ↻3.0h');
    // allowed_warning forces 'warning' regardless of utilization severity.
    expect(seg!.severity).toBe('warning');
  });

  // Regression: SDK sends resetsAt in seconds; formatResetCountdown expects ms.
  // Without the *1000, countdown was always null and `↻Xh` never appeared.
  it('treats resetsAt as seconds (multiplies by 1000)', () => {
    freezeNow();
    const seg = rateLimitInfoToSegment({
      status: 'allowed',
      resetsAt: 1778181600, // seconds, NOT ms
      rateLimitType: 'five_hour',
    });
    expect(seg!.text).toContain('↻');
  });

  it('marks rejected status as critical even without utilization', () => {
    freezeNow();
    const seg = rateLimitInfoToSegment({
      status: 'rejected',
      resetsAt: 1778181600,
      rateLimitType: 'five_hour',
    });
    expect(seg!.severity).toBe('critical');
  });

  it('falls back to raw rateLimitType when label not mapped', () => {
    freezeNow();
    const seg = rateLimitInfoToSegment({
      status: 'allowed',
      rateLimitType: 'mystery_bucket',
    });
    expect(seg!.text).toMatch(/^mystery_bucket:/);
  });

  it('uses "quota" label when rateLimitType missing entirely', () => {
    const seg = rateLimitInfoToSegment({ status: 'allowed' });
    expect(seg!.text).toMatch(/^quota:/);
  });

  it('returns null for nullish info', () => {
    expect(rateLimitInfoToSegment(null)).toBeNull();
    expect(rateLimitInfoToSegment(undefined)).toBeNull();
  });

  it('drops countdown when resetsAt is in the past', () => {
    freezeNow();
    const seg = rateLimitInfoToSegment({
      status: 'allowed',
      resetsAt: Math.floor(FIXED_NOW_MS / 1000) - 3600, // 1h ago
      rateLimitType: 'five_hour',
    });
    expect(seg!.text).toBe('5h: —');
  });
});
