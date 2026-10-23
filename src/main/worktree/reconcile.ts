import { isDeepStrictEqual } from 'node:util';
import { createConnector } from '../connector';
import { TargetFactsResolver, TARGET_OS } from '../connector/target-facts';
import { WorktreeProbe } from '../connector/worktree-probe';
import { getProjectsRepository } from '../projects/repository-provider';
import { buildWorktreeChildConfig } from '@shared/worktree-child-config';
import { isWorktreeUnavailable, WorktreeAvailability, WorktreeScanOutcome, type WorktreeIdentity, type WorktreeScanResult } from '@shared/worktree';
import type { Project, ProjectCreateInput } from '@shared/projects';
import { copyProjectSecrets, deleteProjectSecrets } from '../secret-store';
import { log } from '@shared/logger';
import { scanWorktrees } from './scan';
import { mapWorktrees } from './mapping';

const facts = new TargetFactsResolver();
const inFlight = new Map<string, Promise<WorktreeScanResult>>();
const generations = new Map<string, number>();
const activeLifecycle = new Set<string>();
export function setWorktreeLifecycle(projectId: string, active: boolean): void {
  const project = getProjectsRepository().get(projectId);
  if (!project) throw new Error(`Unknown worktree project: ${projectId}`);
  const id = project.parentProjectId ?? project.id;
  if (active && activeLifecycle.has(id)) throw new Error('Another worktree operation is in progress');
  generations.set(id, (generations.get(id) ?? 0) + 1);
  if (active) activeLifecycle.add(id); else activeLifecycle.delete(id);
}

export function reconcileWorktrees(projectId: string): Promise<WorktreeScanResult> {
  const repo = getProjectsRepository();
  const source = repo.get(projectId);
  if (!source) return Promise.reject(new Error(`Unknown project: ${projectId}`));
  const id = source.parentProjectId ?? source.id;
  const running = inFlight.get(id);
  if (running) return running;
  const task = run(id).catch(error => {
    log.error('worktree', `scan failed mainProjectId=${id}: ${String(error)}`);
    throw error;
  }).finally(() => inFlight.delete(id));
  inFlight.set(id, task);
  return task;
}
async function run(id: string): Promise<WorktreeScanResult> {
  const repo = getProjectsRepository();
  const baseline = repo.getAll();
  const main = repo.get(id);
  if (!main) throw new Error(`Main project not found: ${id}`);
  if (activeLifecycle.has(id)) return { outcome: WorktreeScanOutcome.STALE };
  const generation = generations.get(id) ?? 0;
  const runtime = createConnector(main.connection);
  const target = await facts.resolve(runtime, undefined, main.cwd);
  if (!target.ok) throw new Error(`Cannot inspect target: ${JSON.stringify(target.attempts)}`);
  const probe = new WorktreeProbe(runtime, main.cwd, target.facts.targetOS === TARGET_OS.windows);
  const children = baseline.filter(child => child.parentProjectId === id);
  const snapshot = await scanWorktrees(probe, main.cwd);
  const isCurrent = () => runtime.isCurrentGeneration() && !activeLifecycle.has(id) && generation === (generations.get(id) ?? 0);
  if (!isCurrent() || repo.getAll() !== baseline) return { outcome: WorktreeScanOutcome.STALE };
  if (!snapshot) {
    if (children.length) throw new Error('Main project is no longer a Git repository');
    return { outcome: WorktreeScanOutcome.SKIPPED };
  }
  const identities = new Map<string, WorktreeIdentity | null>();
  for (const child of children) {
    if (!isDeepStrictEqual(child.connection, main.connection)) throw new Error(`Worktree connection differs from main: ${child.id}`);
    identities.set(child.id, await probe.identity(child.cwd));
  }
  const checked = await scanWorktrees(probe, main.cwd);
  if (!checked || !isDeepStrictEqual(snapshot, checked)) throw new Error('Worktree snapshot changed during mapping; rescan to retry');
  const mapping = mapWorktrees(children, identities, snapshot.worktrees);
  const additions: ProjectCreateInput[] = mapping.additions.map(candidate => ({
    ...buildWorktreeChildConfig(main, { cwd: candidate.path, worktreeBranch: candidate.branch, baseBranch: snapshot.branch ?? undefined }),
    worktreeState: { availability: WorktreeAvailability.VALID, identity: candidate.identity },
  }));
  const projects = await repo.reconcileWorktrees(baseline, mapping.updates, additions, {
    prepare: childId => copyProjectSecrets(id, childId), rollback: deleteProjectSecrets,
  }, isCurrent);
  if (!projects) {
    log.debug('worktree', `discarded stale scan mainProjectId=${id}`);
    return { outcome: WorktreeScanOutcome.STALE };
  }
  return { outcome: WorktreeScanOutcome.APPLIED, projects };
}

export async function inspectWorktreeSource(projectId: string): Promise<import('@shared/worktree').WorktreeSource> {
  const repo = getProjectsRepository();
  const project = repo.get(projectId);
  if (!project?.parentProjectId || isWorktreeUnavailable(project)) throw new Error('Worktree is unavailable');
  const parent = repo.get(project.parentProjectId);
  if (!parent) throw new Error('Worktree parent is missing');
  const runtime = createConnector(project.connection);
  const target = await facts.resolve(runtime, undefined, parent.cwd);
  if (!target.ok) throw new Error(`Cannot inspect worktree target: ${JSON.stringify(target.attempts)}`);
  const probe = new WorktreeProbe(runtime, parent.cwd, target.facts.targetOS === TARGET_OS.windows);
  const identity = await probe.identity(project.cwd);
  const parentIdentity = await probe.identity(parent.cwd);
  if (!identity || !parentIdentity || identity.commonDir !== parentIdentity.commonDir || identity.gitDir === parentIdentity.gitDir) throw new Error('Worktree identity no longer matches its parent');
  const commit = (await probe.git(project.cwd, 'rev-parse', '--verify', 'HEAD')).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Invalid worktree HEAD');
  const branch = (await probe.git(project.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
  return { commit, branch: branch === 'HEAD' ? null : branch, identity };
}
