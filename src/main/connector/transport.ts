import fs from 'fs';
import type { Connection } from '@shared/types';
import { shelfPlacement, type ShelfFileType, type ShelfPathContext } from '@shared/shelf-paths';
import { createConnector } from './index';

/**
 * Type-declared file transport (features/app-level-mcps "Transport primitive").
 *
 * The caller declares WHAT a payload is (`type`) + the needed `context`, NOT
 * where it goes on the remote. The placement rule (`@shared/shelf-paths`) maps
 * type → a base + relative path; the base's `home` is resolved ON THE WORKER via
 * the connector's `homePath()`, so the client never hardcodes the remote layout.
 * Bytes are written through the connector's `putFile` (one per-connection
 * implementation — no separate ssh/docker/wsl branching here).
 *
 * MCP is the first consumer; skills + uploads migrate onto this later (strangler).
 * v1 source is a local file path (buffer sources arrive with the uploads
 * migration). Deploy-plane extras (hash-gate, `.heartbeat`) are layered on by the
 * caller, NOT here — `put` only moves bytes to the resolved path.
 */

export interface TransportPutArgs {
  type: ShelfFileType;
  context: ShelfPathContext;
  /** A local file path, OR an in-memory buffer (uploads arrive from the renderer
   *  as bytes with no temp file). Exactly one is provided. */
  source: { localPath: string } | { buffer: Buffer };
}

/** One file under a multi-file type's directory: `rel` is a POSIX path UNDER the
 *  type's placement dir; `localPath` is the local source. */
export interface TransportDirFile {
  rel: string;
  localPath: string;
}

export interface TransportPutDirArgs {
  type: ShelfFileType;
  context: ShelfPathContext;
  files: TransportDirFile[];
}

/** Resolve the absolute destination on the target for a placement + base. POSIX
 *  for remotes; a local base is an OS home that the local connector normalises. */
export function composeRemotePath(base: string, rel: string): string {
  return `${base.replace(/\/+$/, '')}/${rel}`;
}

/** Resolve the placement's absolute base on the WORKER. `home` is resolved via
 *  the connector's `homePath()` (never hardcoded by the client); `cwd` comes from
 *  the context. Shared by `transportPut` and `transportPutDir`. */
async function resolveBase(
  connector: ReturnType<typeof createConnector>,
  type: ShelfFileType,
  placementBase: 'home' | 'cwd',
  context: ShelfPathContext,
): Promise<string> {
  if (placementBase === 'home') return connector.homePath();
  if (!context.cwd) throw new Error(`shelf placement "${type}" requires context.cwd`);
  return context.cwd;
}

async function readSource(source: TransportPutArgs['source']): Promise<Buffer> {
  return 'buffer' in source ? source.buffer : fs.promises.readFile(source.localPath);
}

export async function transportPut(connection: Connection, args: TransportPutArgs): Promise<void> {
  const placement = shelfPlacement(args.type, args.context);
  const connector = createConnector(connection);
  const base = await resolveBase(connector, args.type, placement.base, args.context);
  const dest = composeRemotePath(base, placement.rel);
  await connector.putFile(dest, await readSource(args.source));
}

/**
 * Place a SET of files under one type's DIRECTORY placement, resolving the base
 * ONCE (one `homePath()` round-trip, not one per file). Each file's destination
 * is `<base>/<placement.rel>/<file.rel>`. The CALLER passes the already-filtered
 * file list — the transport does NOT walk the source tree, so type-specific
 * filtering (e.g. skills' `.locked` exclusion) stays with the caller. Used by the
 * skills remote-sync; the deploy-plane extras (mirror-wipe, `.synced`,
 * `.heartbeat`) layer on top via the caller's exec, NOT here.
 */
export async function transportPutDir(connection: Connection, args: TransportPutDirArgs): Promise<void> {
  const placement = shelfPlacement(args.type, args.context);
  const connector = createConnector(connection);
  const base = await resolveBase(connector, args.type, placement.base, args.context);
  const dir = composeRemotePath(base, placement.rel);
  for (const file of args.files) {
    const dest = composeRemotePath(dir, file.rel);
    await connector.putFile(dest, await fs.promises.readFile(file.localPath));
  }
}
