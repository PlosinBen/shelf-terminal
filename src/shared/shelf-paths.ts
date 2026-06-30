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

export type ShelfFileType = 'mcp';

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

export function shelfPlacement(type: ShelfFileType, ctx: ShelfPathContext): ShelfPlacement {
  switch (type) {
    case 'mcp': {
      if (!ctx.appId) throw new Error('shelf placement "mcp" requires context.appId');
      return { base: 'home', rel: `.shelf/apps/${ctx.appId}/mcp-servers.json` };
    }
    default:
      throw new Error(`Unknown shelf file type: ${String(type)}`);
  }
}
