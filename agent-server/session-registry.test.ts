import { describe, it, expect, vi } from 'vitest';
import { createSessionRegistry } from './session-registry';
import type { ServerBackend } from './providers/types';

// Minimal ServerBackend stand-in — the registry only ever holds and hands back
// the object; it never calls provider methods. A distinct object per create()
// lets us assert identity (which sid got which runtime).
function makeBackend(): ServerBackend {
  return { query: vi.fn(), stop: vi.fn(), dispose: vi.fn() } as unknown as ServerBackend;
}

describe('session-registry (isolated default: runtimeKey = sid)', () => {
  it('gives every sid its OWN runtime, 1:1', () => {
    const reg = createSessionRegistry({ createRuntime: () => makeBackend() });
    const a = reg.open('s1', 'claude');
    const b = reg.open('s2', 'claude');
    expect(a).not.toBe(b);
    expect(reg.get('s1')).toBe(a);
    expect(reg.get('s2')).toBe(b);
    expect(reg.size()).toBe(2);
    expect(reg.runtimes()).toHaveLength(2);
  });

  it('open is idempotent for the same sid (no second runtime)', () => {
    const create = vi.fn(() => makeBackend());
    const reg = createSessionRegistry({ createRuntime: create });
    const first = reg.open('s1', 'copilot');
    const again = reg.open('s1', 'copilot');
    expect(again).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(reg.size()).toBe(1);
  });

  it('get returns undefined for an unknown sid', () => {
    const reg = createSessionRegistry({ createRuntime: () => makeBackend() });
    expect(reg.get('nope')).toBeUndefined();
  });

  it('close drops the sid and returns its runtime to dispose (isolated → always unshared)', () => {
    const reg = createSessionRegistry({ createRuntime: () => makeBackend() });
    const a = reg.open('s1', 'claude');
    const disposed = reg.close('s1');
    expect(disposed).toBe(a);
    expect(reg.get('s1')).toBeUndefined();
    expect(reg.size()).toBe(0);
    expect(reg.runtimes()).toHaveLength(0);
  });

  it('close on an unknown sid returns undefined', () => {
    const reg = createSessionRegistry({ createRuntime: () => makeBackend() });
    expect(reg.close('nope')).toBeUndefined();
  });
});

describe('session-registry (shared seam: runtimeKey = provider)', () => {
  it('routes N sids of one provider to a SINGLE shared runtime', () => {
    const create = vi.fn(() => makeBackend());
    const reg = createSessionRegistry({
      createRuntime: create,
      runtimeKeyFor: (_sid, provider) => provider,
    });
    const a = reg.open('s1', 'copilot');
    const b = reg.open('s2', 'copilot');
    expect(a).toBe(b); // shared
    expect(create).toHaveBeenCalledTimes(1);
    expect(reg.runtimes()).toHaveLength(1);
  });

  it('close does NOT dispose a shared runtime while another sid still uses it', () => {
    const reg = createSessionRegistry({
      createRuntime: () => makeBackend(),
      runtimeKeyFor: (_sid, provider) => provider,
    });
    reg.open('s1', 'copilot');
    reg.open('s2', 'copilot');
    // s1 leaves — runtime still used by s2 → nothing to dispose.
    expect(reg.close('s1')).toBeUndefined();
    expect(reg.runtimes()).toHaveLength(1);
    // s2 leaves — now dispose the runtime.
    expect(reg.close('s2')).toBeDefined();
    expect(reg.runtimes()).toHaveLength(0);
  });
});
