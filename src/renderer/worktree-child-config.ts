import type { AgentProvider, ProjectConfig } from '@shared/types';

/**
 * Build a worktree sub-project's config by cloning the parent project's SETUP
 * while giving it a FRESH identity. A worktree is the same project on a different
 * branch, so it should develop in the same environment: inherit env, init script,
 * tab layout, quick commands, and agent preferences. Secrets live in a separate
 * encrypted store (not in ProjectConfig) and are copied alongside by the caller.
 *
 * Deliberately NOT inherited:
 *  - id / cwd / parentProjectId / worktreeBranch / baseBranch — worktree-specific
 *    identity, always set fresh here.
 *  - agentSessionIds — the whole point of the flow is that the worktree boots a
 *    FRESH agent (which reads the migrated note); inheriting the parent's session
 *    ids would resume the parent's agent instead. Omitted → fresh sessions.
 */
export function buildWorktreeChildConfig(
  parent: ProjectConfig,
  opts: { id: string; cwd: string; worktreeBranch: string; baseBranch?: string; defaultAgentProvider?: AgentProvider },
): ProjectConfig {
  return {
    // ── inherited setup ──
    name: parent.name,
    connection: parent.connection,
    maxTabs: parent.maxTabs,
    initScript: parent.initScript,
    envPlain: parent.envPlain,
    defaultTabs: parent.defaultTabs,
    quickCommands: parent.quickCommands,
    defaultAgentProvider: opts.defaultAgentProvider ?? parent.defaultAgentProvider,
    agentPrefs: parent.agentPrefs,
    openAgentOnConnect: parent.openAgentOnConnect,
    // ── fresh worktree identity ──
    id: opts.id,
    cwd: opts.cwd,
    parentProjectId: parent.id,
    worktreeBranch: opts.worktreeBranch,
    baseBranch: opts.baseBranch,
    // agentSessionIds intentionally omitted → fresh agent session.
  };
}
