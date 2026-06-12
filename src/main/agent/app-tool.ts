/**
 * App-tool dispatcher (main side) — turns an `app_tool` request (op + args)
 * coming from an agent-server bridge tool into a call against client-owned
 * resources (currently app-level skills via skills-store), and returns a
 * structured result the bridge tool relays back to the model.
 *
 * Shape is the B-registry from .agent/features/app-level-capabilities.md:
 * `op = resource.verb`, each entry flags `safe` (read = no confirm) so the
 * caller can gate mutations. This module is the SINGLE place that maps an op to
 * a resource action — adding an app tool = add a registry entry + (for writes)
 * its mutation path. PURE of any wire/IPC concern, so it's unit-testable.
 *
 * Step 1 ships the safe READ ops only (list/get). Mutations (create/update) +
 * their confirm + the skills:changed broadcast land in later steps.
 */
import { listSkills, getSkill } from '../skills-store';

export interface AppToolResult {
  ok: boolean;
  /** Present when ok — JSON-serializable payload for the tool result. */
  data?: unknown;
  /** Present when !ok — human-readable reason surfaced to the model. */
  error?: string;
}

interface AppToolDef {
  /** Safe (read-only) ops need no user confirmation; mutations do. */
  safe: boolean;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const REGISTRY: Record<string, AppToolDef> = {
  'app_skill.list': {
    safe: true,
    run: async () => ({ skills: await listSkills() }),
  },
  'app_skill.get': {
    safe: true,
    run: async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) throw new Error('app_skill.get requires a "name"');
      const content = await getSkill(name);
      if (content === null) throw new Error(`skill not found: ${name}`);
      return { name, content };
    },
  },
};

/** True iff `op` is a known safe (read-only) op — caller may skip confirmation. */
export function isSafeAppToolOp(op: string): boolean {
  return REGISTRY[op]?.safe === true;
}

/** True iff `op` is registered at all. */
export function isKnownAppToolOp(op: string): boolean {
  return op in REGISTRY;
}

/** Run an app-tool op. Never throws — failures come back as `{ ok:false, error }`. */
export async function handleAppTool(op: string, args: Record<string, unknown> = {}): Promise<AppToolResult> {
  const def = REGISTRY[op];
  if (!def) return { ok: false, error: `unknown app_tool op: ${op}` };
  try {
    return { ok: true, data: await def.run(args) };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
