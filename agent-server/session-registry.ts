// Two-map session hosting for the dispatch-layering feature (SDD "Session hosting
// model"). The harness holds:
//   sessions:  sid        → runtimeKey   (which runtime a session lives on)
//   runtimes:  runtimeKey → ServerBackend (the shared-vs-isolated dimension)
//
// ISOLATED (this module, the Phase-1 default): `runtimeKeyFor = sid`, so every sid
// gets its OWN runtime = a single-session `ServerBackend` (today's providers,
// unchanged) → `sessions`/`runtimes` are 1:1. This is what removes `activeBackend`
// ("whoever sent last") from index.ts: out-of-turn messages route by sid into this
// registry instead.
//
// SHARED is a POLICY, not a new architecture (see the two-map SDD): it only flips
// `runtimeKeyFor` to `provider:account` so N sids resolve to ONE runtime. That
// realization needs a session-explicit multi-session Runtime and is the gated-G
// generalization — deliberately OUT of scope here. The seam (the injected
// `runtimeKeyFor`) is in place so G is a policy change, not a wire retrofit.
import type { ServerBackend } from './providers/types';

export type RuntimeKey = string;

export interface SessionRegistryDeps {
  /** Build a fresh single-session backend for a provider (index.ts injects its
   *  `getBackend`). Called once per distinct runtimeKey. */
  createRuntime: (provider: string) => ServerBackend;
  /** Maps a session to its runtime. Default (isolated): the sid itself → one
   *  runtime per session. Overridden in gated-G for shared (provider:account). */
  runtimeKeyFor?: (sid: string, provider: string) => RuntimeKey;
}

export interface SessionRegistry {
  /** Ensure a runtime for `sid` (reusing one when its runtimeKey already exists)
   *  and return it. Idempotent for the same sid. */
  open(sid: string, provider: string): ServerBackend;
  /** The runtime hosting `sid`, or undefined if the sid is unknown. */
  get(sid: string): ServerBackend | undefined;
  /**
   * Drop `sid`. Returns the runtime to DISPOSE iff no other sid still shares its
   * runtimeKey (the caller owns disposal — the registry does no side effects);
   * returns undefined when the runtime is still in use or the sid was unknown.
   */
  close(sid: string): ServerBackend | undefined;
  /** All distinct runtimes — for shutdown / reaper / reload_skills fan-out. */
  runtimes(): ServerBackend[];
  /** Number of live sessions. */
  size(): number;
}

export function createSessionRegistry(deps: SessionRegistryDeps): SessionRegistry {
  const runtimeKeyFor = deps.runtimeKeyFor ?? ((sid: string) => sid);
  const sessions = new Map<string, RuntimeKey>();
  const runtimes = new Map<RuntimeKey, ServerBackend>();

  function open(sid: string, provider: string): ServerBackend {
    const rk = runtimeKeyFor(sid, provider);
    let rt = runtimes.get(rk);
    if (!rt) {
      rt = deps.createRuntime(provider);
      runtimes.set(rk, rt);
    }
    sessions.set(sid, rk);
    return rt;
  }

  function get(sid: string): ServerBackend | undefined {
    const rk = sessions.get(sid);
    return rk === undefined ? undefined : runtimes.get(rk);
  }

  function close(sid: string): ServerBackend | undefined {
    const rk = sessions.get(sid);
    if (rk === undefined) return undefined;
    sessions.delete(sid);
    // Still shared by another session → leave the runtime alive.
    for (const other of sessions.values()) {
      if (other === rk) return undefined;
    }
    const rt = runtimes.get(rk);
    runtimes.delete(rk);
    return rt;
  }

  return {
    open,
    get,
    close,
    runtimes: () => [...runtimes.values()],
    size: () => sessions.size,
  };
}
