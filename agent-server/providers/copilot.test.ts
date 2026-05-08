import { describe, it, expect } from 'vitest';
import { quotaSnapshotToSegment, parseApplyPatch } from './copilot';

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

  // Regression: Copilot CLI derives `usedRequests` from
  // `entitlement * (1 - percent_remaining)` so it caps at entitlementRequests
  // and the real overage count lives in the separate `overage` field. Earlier
  // formula `usedRequests / entitlement` saturated at 100%; current formula
  // `(usedRequests + overage) / entitlement` surfaces real overage.
  it('shows overage above 100% by combining usedRequests + overage', () => {
    const seg = quotaSnapshotToSegment('premium_interactions', {
      isUnlimitedEntitlement: false,
      entitlementRequests: 300,
      usedRequests: 300, // capped at entitlement by the SDK
      remainingPercentage: 0,
      usageAllowedWithExhaustedQuota: true,
      overage: 60, // real overage lives here
      overageAllowedWithExhaustedQuota: true,
    });
    expect(seg).not.toBeNull();
    expect(seg!.text).toMatch(/^premium: 120%/);
  });

  // Pathological case from the field report: 255% utilisation needs to render
  // verbatim, not get clipped to 100%.
  it('renders extreme overage like 255% verbatim', () => {
    const seg = quotaSnapshotToSegment('premium_interactions', {
      isUnlimitedEntitlement: false,
      entitlementRequests: 100,
      usedRequests: 100,
      remainingPercentage: 0,
      usageAllowedWithExhaustedQuota: true,
      overage: 155,
      overageAllowedWithExhaustedQuota: true,
    });
    expect(seg!.text).toMatch(/^premium: 255%/);
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

describe('parseApplyPatch', () => {
  it('parses single-hunk Update into oldString/newString', () => {
    const patch = `*** Begin Patch
*** Update File: /tmp/foo.md
@@
-# Old Title
+# New Title
*** End Patch
`;
    const out = parseApplyPatch(patch);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('update');
    expect(out!.filePath).toBe('/tmp/foo.md');
    expect(out!.diff).toEqual({ oldString: '# Old Title', newString: '# New Title' });
  });

  it('preserves context lines on both sides of the diff', () => {
    const patch = `*** Begin Patch
*** Update File: /tmp/code.ts
@@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
*** End Patch
`;
    const out = parseApplyPatch(patch);
    expect(out!.diff!.oldString).toBe('const a = 1;\nconst b = 2;\nconst c = 4;');
    expect(out!.diff!.newString).toBe('const a = 1;\nconst b = 3;\nconst c = 4;');
  });

  it('parses Add into content', () => {
    const patch = `*** Begin Patch
*** Add File: /tmp/hello.txt
+hi
+there
*** End Patch
`;
    const out = parseApplyPatch(patch);
    expect(out!.kind).toBe('add');
    expect(out!.filePath).toBe('/tmp/hello.txt');
    expect(out!.content).toBe('hi\nthere');
  });

  it('returns null for multi-hunk Update (out of MVP scope)', () => {
    const patch = `*** Begin Patch
*** Update File: /tmp/foo.ts
@@
-a
+b
@@
-c
+d
*** End Patch
`;
    expect(parseApplyPatch(patch)).toBeNull();
  });

  it('returns null for multi-file patches', () => {
    const patch = `*** Begin Patch
*** Update File: /tmp/a.ts
@@
-x
+y
*** Update File: /tmp/b.ts
@@
-p
+q
*** End Patch
`;
    expect(parseApplyPatch(patch)).toBeNull();
  });

  it('returns null for Delete operations (not yet supported)', () => {
    const patch = `*** Begin Patch
*** Delete File: /tmp/gone.txt
*** End Patch
`;
    expect(parseApplyPatch(patch)).toBeNull();
  });

  it('returns null for missing Begin/End markers', () => {
    expect(parseApplyPatch('*** Update File: /tmp/x.ts\n-a\n+b')).toBeNull();
    expect(parseApplyPatch('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseApplyPatch(null as any)).toBeNull();
    expect(parseApplyPatch({} as any)).toBeNull();
  });
});
