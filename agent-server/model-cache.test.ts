import { describe, it, expect } from 'vitest';
import { createModelCache } from './model-cache';

describe('model-cache (TTL store)', () => {
  it('returns undefined for an absent key', () => {
    const c = createModelCache({ ttlMs: 1000, now: () => 0 });
    expect(c.get('models:copilot')).toBeUndefined();
  });

  it('returns a put value within TTL', () => {
    let t = 0;
    const c = createModelCache({ ttlMs: 1000, now: () => t });
    c.put('models:copilot', [{ id: 'gpt' }]);
    t = 999;
    expect(c.get('models:copilot')).toEqual([{ id: 'gpt' }]);
  });

  it('evicts + returns undefined once the entry is older than TTL', () => {
    let t = 0;
    const c = createModelCache({ ttlMs: 1000, now: () => t });
    c.put('models:copilot', [{ id: 'gpt' }]);
    t = 1000; // exactly TTL → expired
    expect(c.get('models:copilot')).toBeUndefined();
    // a later put refreshes the timestamp
    c.put('models:copilot', [{ id: 'gpt2' }]);
    t = 1500;
    expect(c.get('models:copilot')).toEqual([{ id: 'gpt2' }]);
  });

  it('keys are independent (provider-scoped)', () => {
    const c = createModelCache({ ttlMs: 1000, now: () => 0 });
    c.put('models:copilot', [1]);
    c.put('models:claude', [2]);
    expect(c.get('models:copilot')).toEqual([1]);
    expect(c.get('models:claude')).toEqual([2]);
  });
});
