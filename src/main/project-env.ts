import { getProjectsRepository } from './projects/repository-provider';
import { sanitizeEnvMap, type EnvMap } from '@shared/project-env';

/**
 * Resolve the env map Shelf injects into the processes it launches for a project
 * — the single source both spawn surfaces (agent-server in agent/remote.ts, and
 * terminals in the connectors' createShell) read from.
 *
 * Reads only canonical Project.envPlain; no side-car or key storage participates.
 * Reserved keys / malformed names / non-string values are dropped as a defensive
 * backstop. Unknown projectId → empty map. See project-env#8.
 */
export function resolveProjectEnv(projectId: string | undefined): EnvMap {
  if (!projectId) return {};
  const project = getProjectsRepository().get(projectId);
  if (!project) return {};
  return sanitizeEnvMap(project.envPlain);
}
