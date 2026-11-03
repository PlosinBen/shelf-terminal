import type { AgentProvider } from './types';
import type { Project, ProjectCreateInput } from './projects';
import { providerLabel } from './agent-providers';

/**
 * Build a worktree sub-project's config by cloning the parent project's SETUP
 * while giving it a FRESH identity. A worktree is the same project on a different
 * branch, so it should develop in the same environment: inherit env, init script,
 * quick commands. Tabs and agent preferences are deliberately fresh.
 *
 * Deliberately NOT inherited:
 *  - id / cwd / parentProjectId / worktreeBranch / baseBranch — worktree-specific
 *    identity, always set fresh here.
 *  - agentViews — the whole point of the flow is that the worktree boots a
 *    FRESH agent (which reads the migrated note); inheriting the parent's session
 *    ids would resume the parent's agent instead. Omitted → fresh sessions.
 */
export function buildWorktreeChildConfig(
  parent: Project,
  opts: {
    cwd: string;
    worktreeBranch: string | null;
    baseBranch?: string;
    startupAgentProvider?: AgentProvider;
  },
): ProjectCreateInput {
  return {
    // ── inherited setup ──
    name: parent.name,
    connection: parent.connection,
    maxTabs: parent.maxTabs,
    initScript: parent.initScript,
    envPlain: parent.envPlain,
    defaultTabs: opts.startupAgentProvider
      ? [
        { name: providerLabel(opts.startupAgentProvider), kind: 'agent', provider: opts.startupAgentProvider },
        { name: 'Terminal' },
      ]
      : [{ name: 'Terminal' }],
    quickCommands: parent.quickCommands,
    featureNoteDir: parent.featureNoteDir,
    // ── fresh worktree identity ──
    cwd: opts.cwd,
    parentProjectId: parent.id,
    worktreeBranch: opts.worktreeBranch,
    baseBranch: opts.baseBranch ?? null,
    // No parent Agent records or prefs → fresh sessions and provider defaults.
  };
}
