import { describe, it, expect } from 'vitest';
import { quotaSnapshotToSegment } from './copilot';

describe('quotaSnapshotToSegment', () => {
  it('renders premium quota at 100%', () => {
    const seg = quotaSnapshotToSegment('premium_interactions', {
      isUnlimitedEntitlement: false,
      entitlementRequests: 300,
      usedRequests: 300,
      remainingPercentage: 0,
      usageAllowedWithExhaustedQuota: true,
      overage: 0,
      overageAllowedWithExhaustedQuota: true,
    });
    expect(seg).not.toBeNull();
    expect(seg!.text).toMatch(/^premium: 100%/);
  });

  // Regression: GitHub's `remainingPercentage` is clamped to 0–1, so when the
  // user goes into overage (e.g. used 360 / 300), the previous formula
  // `1 - remainingPercentage` saturated at 100%. Use usedRequests/entitlement
  // so 120% surfaces in the status bar.
  it('shows overage above 100% when usedRequests exceeds entitlement', () => {
    const seg = quotaSnapshotToSegment('premium_interactions', {
      isUnlimitedEntitlement: false,
      entitlementRequests: 300,
      usedRequests: 360,
      remainingPercentage: 0, // GitHub clamps to 0 in overage
      usageAllowedWithExhaustedQuota: true,
      overage: 60,
      overageAllowedWithExhaustedQuota: true,
    });
    expect(seg).not.toBeNull();
    expect(seg!.text).toMatch(/^premium: 120%/);
  });

  it('marks exhausted quota with no overage permission as critical', () => {
    const seg = quotaSnapshotToSegment('premium_interactions', {
      isUnlimitedEntitlement: false,
      entitlementRequests: 300,
      usedRequests: 300,
      remainingPercentage: 0,
      usageAllowedWithExhaustedQuota: false,
      overage: 0,
      overageAllowedWithExhaustedQuota: false,
    });
    expect(seg!.severity).toBe('critical');
  });

  it('returns null for unlimited entitlement', () => {
    const seg = quotaSnapshotToSegment('chat_interactions', {
      isUnlimitedEntitlement: true,
      entitlementRequests: 0,
      usedRequests: 12,
      remainingPercentage: 1,
      usageAllowedWithExhaustedQuota: true,
      overage: 0,
      overageAllowedWithExhaustedQuota: true,
    });
    expect(seg).toBeNull();
  });

  it('falls back to remainingPercentage when entitlementRequests is 0', () => {
    const seg = quotaSnapshotToSegment('premium_interactions', {
      isUnlimitedEntitlement: false,
      entitlementRequests: 0,
      usedRequests: 0,
      remainingPercentage: 0.7,
      usageAllowedWithExhaustedQuota: true,
      overage: 0,
      overageAllowedWithExhaustedQuota: true,
    });
    expect(seg!.text).toMatch(/^premium: 30%/);
  });

  it('uses raw key as label when no friendly mapping exists', () => {
    const seg = quotaSnapshotToSegment('mystery_quota', {
      isUnlimitedEntitlement: false,
      entitlementRequests: 100,
      usedRequests: 50,
      remainingPercentage: 0.5,
      usageAllowedWithExhaustedQuota: true,
      overage: 0,
      overageAllowedWithExhaustedQuota: true,
    });
    expect(seg!.text).toMatch(/^mystery_quota: 50%/);
  });
});
