import { getProjects } from './app-state';
import { sanitizeEnvMap, type EnvMap } from '@shared/project-env';

/**
 * Resolve the env map Shelf injects into the processes it launches for a project
 * — the single source both spawn surfaces (agent-server in agent/remote.ts, and
 * terminals in the connectors' createShell) read from.
 *
 * Today this is the project's PLAIN env (projectConfig.envPlain); the encrypted
 * secret side-car is decrypted and merged here in a later phase, so callers never
 * learn whether a value was plain or secret. Reserved keys / malformed names /
 * non-string values are dropped as a defensive backstop (the config UI already
 * blocks them at input). Unknown projectId → empty map.
 */
export function resolveProjectEnv(projectId: string | undefined): EnvMap {
  if (!projectId) return {};
  const project = getProjects().find((p) => p.id === projectId);
  if (!project) return {};
  return sanitizeEnvMap(project.envPlain);
}
