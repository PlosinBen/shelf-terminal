import type { AgentProvider } from './types';
import type { Project, ProjectCreateInput } from './projects';
import { isAgentProvider, providerLabel, visibleAgentProviderEntries } from './agent-providers';

export interface WorktreeStartupOptions {
  startupAgentProvider?: AgentProvider;
  startupTerminal?: boolean;
}

export interface WorktreeCreatePrefill {
  /** Trusted MCP caller View; never populated from model arguments. */
  sourceAgentSessionId?: string;
  branch?: string;
  notePaths?: string[];
  agent?: AgentProvider;
}
export interface WorktreeCreateProposal extends WorktreeCreatePrefill {
  projectId: string;
}

export const WORKTREE_STARTUP_REQUIRED = 'Select at least one initial view: Agent or Terminal.';
export const WORKTREE_AGENT_SOURCE_REQUIRED = 'Select the Agent view whose settings should be copied.';
export const WORKTREE_AGENT_SOURCE_INVALID = 'Invalid worktree Agent preference source';

export function resolveWorktreeAgentSource(parent: Project, provider: AgentProvider, preferredSessionId?: string): string | undefined {
  const matches = Object.entries(parent.agentViews).filter(([, view]) => view.provider === provider);
  if (preferredSessionId && matches.some(([id]) => id === preferredSessionId)) return preferredSessionId;
  return matches.length === 1 ? matches[0][0] : undefined;
}

export function validateWorktreeAgent(value: unknown, includeInternal: boolean): AgentProvider | undefined {
  if (value === undefined) return undefined;
  if (!isAgentProvider(value)) throw new Error(`Invalid worktree agent provider: ${String(value)}`);
  if (!visibleAgentProviderEntries(includeInternal).some(([id]) => id === value)) {
    throw new Error(`Worktree agent provider is not available in this environment: ${value}`);
  }
  return value;
}

/** Shared defaults; main owns the environment policy at the Git mutation boundary. */
export function normalizeWorktreeStartup(value: unknown, includeInternal: boolean): WorktreeStartupOptions {
  if (value === undefined) return { startupTerminal: true };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid worktree startup options');
  const input = value as Record<string, unknown>;
  const startupAgentProvider = validateWorktreeAgent(input.startupAgentProvider, includeInternal);
  const startupTerminal = input.startupTerminal === undefined ? true : input.startupTerminal;
  if (typeof startupTerminal !== 'boolean') throw new Error('Worktree startupTerminal must be a boolean');
  if (!startupAgentProvider && !startupTerminal) throw new Error(WORKTREE_STARTUP_REQUIRED);
  return { startupAgentProvider, startupTerminal };
}

/**
 * Build a worktree sub-project's config by cloning the parent project's SETUP
 * while giving it a FRESH identity. A worktree is the same project on a different
 * branch, so it should develop in the same environment: inherit env, init script,
 * quick commands. Agent identity is fresh; a selected same-provider View supplies prefs.
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
    sourceAgentSessionId?: string;
  } & WorktreeStartupOptions,
): ProjectCreateInput {
  const startup = normalizeWorktreeStartup(opts, true);
  if (opts.sourceAgentSessionId && (!startup.startupAgentProvider
    || parent.agentViews[opts.sourceAgentSessionId]?.provider !== startup.startupAgentProvider)) {
    throw new Error(WORKTREE_AGENT_SOURCE_INVALID);
  }
  return {
    ...(opts.sourceAgentSessionId ? { worktreeAgentSourceSessionId: opts.sourceAgentSessionId } : {}),
    // ── inherited setup ──
    name: parent.name,
    connection: parent.connection,
    maxTabs: parent.maxTabs,
    initScript: parent.initScript,
    envPlain: parent.envPlain,
    defaultTabs: [
      ...(startup.startupAgentProvider
        ? [{ name: providerLabel(startup.startupAgentProvider), kind: 'agent' as const, provider: startup.startupAgentProvider }]
        : []),
      ...(startup.startupTerminal ? [{ name: 'Terminal' }] : []),
    ],
    quickCommands: parent.quickCommands,
    featureNoteDir: parent.featureNoteDir,
    // ── fresh worktree identity ──
    cwd: opts.cwd,
    parentProjectId: parent.id,
    worktreeBranch: opts.worktreeBranch,
    baseBranch: opts.baseBranch ?? null,
    // Main materializes a fresh View, then copies only the selected source's prefs.
  };
}
