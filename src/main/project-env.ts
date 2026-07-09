import { getProjects } from './app-state';
import { resolveProjectSecrets } from './secret-store';
import { sanitizeEnvMap, type EnvMap } from '@shared/project-env';

/**
 * Resolve the env map Shelf injects into the processes it launches for a project
 * — the single source both spawn surfaces (agent-server in agent/remote.ts, and
 * terminals in the connectors' createShell) read from.
 *
 * Merges the project's PLAIN env (projectConfig.envPlain, stored in the clear)
 * with its SECRET env (decrypted just-in-time from the encrypted side-car), so
 * callers never learn whether a value was plain or secret. A same-named plain +
 * secret is blocked at input; if one slips through, secret wins here (last
 * write). Reserved keys / malformed names / non-string values are dropped as a
 * defensive backstop. Unknown projectId → empty map.
 */
export function resolveProjectEnv(projectId: string | undefined): EnvMap {
  if (!projectId) return {};
  const project = getProjects().find((p) => p.id === projectId);
  if (!project) return {};
  const plain = sanitizeEnvMap(project.envPlain);
  const secret = resolveProjectSecrets(projectId);
  return { ...plain, ...secret };
}
