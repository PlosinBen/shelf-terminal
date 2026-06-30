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
  /** v1: a local file whose bytes are placed at the resolved destination. */
  source: { localPath: string };
}

/** Resolve the absolute destination on the target for a placement + base. POSIX
 *  for remotes; a local base is an OS home that the local connector normalises. */
export function composeRemotePath(base: string, rel: string): string {
  return `${base.replace(/\/+$/, '')}/${rel}`;
}

export async function transportPut(connection: Connection, args: TransportPutArgs): Promise<void> {
  const placement = shelfPlacement(args.type, args.context);
  const connector = createConnector(connection);

  let base: string;
  if (placement.base === 'home') {
    base = await connector.homePath();
  } else {
    if (!args.context.cwd) throw new Error(`shelf placement "${args.type}" requires context.cwd`);
    base = args.context.cwd;
  }

  const dest = composeRemotePath(base, placement.rel);
  const buffer = await fs.promises.readFile(args.source.localPath);
  await connector.putFile(dest, buffer);
}
