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
  /** Leaf file name under a cwd-relative type's dir (e.g. an upload's
   *  prefixed/sanitised filename). The caller owns naming policy (prefix,
   *  sanitisation) so this module stays a pure, deterministic path rule. */
  name?: string;
}

/** The upload dir, relative to a project cwd. SINGLE SOURCE for the `.tmp/shelf`
 *  layout — the `upload` placement and `connector/file-utils` (buildPaths +
 *  list/size/clear) both derive from this, so the literal lives in one place. */
export const SHELF_UPLOAD_DIR_REL = '.tmp/shelf';
/** The gitignore that hides the upload scratch dir from the project's repo. */
export const SHELF_UPLOAD_GITIGNORE_REL = '.tmp/.gitignore';

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
export const ShelfFileTypeSkill = 'skill';
export const ShelfFileTypeUpload = 'upload';
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
  // The app-level skills tree (a DIRECTORY rel — the worker's agent-server reads
  // `~/.shelf/apps/<appId>/skills`, see deployment#1). Files are placed under it
  // one-by-one via transportPutDir; this is the single source for that layout,
  // mirrored locally by skills-projection `localSkillsTarget`.
  [ShelfFileTypeSkill]: (ctx: ShelfPathContext): ShelfPlacement => {
    if (!ctx.appId) throw new Error('shelf placement "skill" requires context.appId');
    return { base: 'home', rel: `.shelf/apps/${ctx.appId}/skills` };
  },
  // A user upload (paste/drag) under the project's cwd-relative scratch dir. The
  // caller supplies the already-prefixed/sanitised leaf `name`; this maps it
  // under the single-source upload dir. cwd-relative, so base is 'cwd'.
  [ShelfFileTypeUpload]: (ctx: ShelfPathContext): ShelfPlacement => {
    if (!ctx.name) throw new Error('shelf placement "upload" requires context.name');
    return { base: 'cwd', rel: `${SHELF_UPLOAD_DIR_REL}/${ctx.name}` };
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
