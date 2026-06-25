import path from 'path';
import fs from 'fs';
import { projectDir, projectsRoot } from './project-storage';
import { log } from '@shared/logger';
import type { WebGrantsByProject } from '@shared/web-session';

// Per-project agent `web.fetch` grants: which origins the agent in THIS project
// may hit with the user's logged-in web session. Key = (projectId, origin).
//
// Grant is per-project (least privilege) even though the cookie jar is global:
// "you logged in" = global identity; "this agent may USE it" = per-project
// delegation. A prompt-injected agent can only abuse origins granted in its own
// project, not everything you ever authorized. Grants are until-revoked (removed
// via the whitelist UI). See the web-tab network-identity design.
//
// `origin` MUST be the canonical value from parseHttpOrigin().origin so checks
// and grants match exactly.

function grantsPath(projectId: string): string {
  return path.join(projectDir(projectId), 'web-grants.json');
}

function readGrants(projectId: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(grantsPath(projectId), 'utf-8'));
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
    log.error('web-grants', `grants file for ${projectId} is not an array — ignoring`);
  } catch (err) {
    // Missing file is the normal "no grants yet" case; only log real corruption.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log.error('web-grants', `failed to read grants for ${projectId}`, err);
    }
  }
  return [];
}

function writeGrants(projectId: string, origins: string[]): void {
  const dir = projectDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const deduped = [...new Set(origins)].sort();
  fs.writeFileSync(grantsPath(projectId), JSON.stringify(deduped, null, 2), 'utf-8');
}

export function isGranted(projectId: string, origin: string): boolean {
  return readGrants(projectId).includes(origin);
}

export function grant(projectId: string, origin: string): void {
  const current = readGrants(projectId);
  if (!current.includes(origin)) writeGrants(projectId, [...current, origin]);
}

export function revoke(projectId: string, origin: string): void {
  writeGrants(projectId, readGrants(projectId).filter((o) => o !== origin));
}

export function listGrants(projectId: string): string[] {
  return readGrants(projectId);
}

/**
 * Every project's grants (projectId → origins) for the whitelist UI. Scans the
 * projects storage root; only includes projects that have at least one grant.
 */
export function listAllGrants(): WebGrantsByProject {
  const out: WebGrantsByProject = {};
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(projectsRoot());
  } catch {
    return out;
  }
  for (const id of ids) {
    const grants = readGrants(id);
    if (grants.length) out[id] = grants;
  }
  return out;
}
