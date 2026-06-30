/**
 * Single source of truth for the per-app "shelf" file layout on a worker —
 * shared by the TRANSPORT (placement side, `connector/transport.ts`) and the
 * AGENT-SERVER (read side) so both ends agree on one rule. See
 * features/app-level-mcps "Transport primitive".
 *
 * Type-declared placement: a caller declares WHAT a payload is (a `type`), not
 * WHERE it goes on the remote. This maps `type` → a path relative to a base
 * (`home` = the worker's $HOME, resolved on the worker by the transport; `cwd` =
 * the project working dir). The client thus never hardcodes the remote layout
 * (`~/.shelf/...`).
 *
 * CLOSED allowlist — an unknown type throws (no arbitrary type→path). New types
 * (`skill`, `upload`) are added here as they migrate onto the transport.
 */

export interface ShelfPathContext {
  /** App instance id — required for fixed-layout types under `~/.shelf/apps/<appId>`. */
  appId?: string;
  /** Project working dir — required for cwd-relative types (e.g. uploads). */
  cwd?: string;
}

export interface ShelfPlacement {
  /** Which base `rel` hangs off: the worker's home, or the project cwd. */
  base: 'home' | 'cwd';
  /** POSIX-relative path under `base`. */
  rel: string;
}

// Named type constants — the ONLY place each type string literal is written.
// Both ends reference these instead of a bare 'mcp' / 'test': the client when it
// declares a payload (`transportPut({ type: ShelfFileTypeMcp })`) and the
// consumption side when it resolves a path (`shelfPlacement(ShelfFileTypeMcp)`).
export const ShelfFileTypeMcp = 'mcp';
export const ShelfFileTypeTest = 'test';

/**
 * The closed allowlist: each type maps to a placement builder. `ShelfFileType`
 * derives from the keys and `shelfPlacement` dispatches through it, so adding a
 * type is one constant + one entry here (no union edit, no switch case).
 */
const SHELF_PLACEMENTS = {
  [ShelfFileTypeMcp]: (ctx: ShelfPathContext): ShelfPlacement => {
    if (!ctx.appId) throw new Error('shelf placement "mcp" requires context.appId');
    return { base: 'home', rel: `.shelf/apps/${ctx.appId}/mcp-servers.json` };
  },
  // Verification-only: a neutral payload to confirm a connection's transport
  // CHANNEL moves bytes (ssh/docker/wsl putFile), decoupled from any real
  // consumption path. See transport-channel.docker.test.ts.
  [ShelfFileTypeTest]: (_ctx: ShelfPathContext): ShelfPlacement => ({ base: 'home', rel: '.shelf/test/transport-check' }),
} as const satisfies Record<string, (ctx: ShelfPathContext) => ShelfPlacement>;

export type ShelfFileType = keyof typeof SHELF_PLACEMENTS;

export function shelfPlacement(type: ShelfFileType, ctx: ShelfPathContext): ShelfPlacement {
  const build = SHELF_PLACEMENTS[type];
  if (!build) throw new Error(`Unknown shelf file type: ${String(type)}`);
  return build(ctx);
}
