import { describe, expect, it } from 'vitest';
import { resolveCodexSdkCodexPathOverride } from './runtime';

describe('Codex SDK native runtime seam', () => {
  it('returns the explicit native Codex path for SDK codexPathOverride', () => {
    expect(resolveCodexSdkCodexPathOverride(() => '/runtime/codex')).toBe('/runtime/codex');
  });

  it('fails loudly with an SDK-specific diagnostic and no PATH fallback', () => {
    expect(() => resolveCodexSdkCodexPathOverride(() => undefined)).toThrow(/codexPathOverride/);
    expect(() => resolveCodexSdkCodexPathOverride(() => undefined)).toThrow(/does not fall back to PATH/);
  });
});
