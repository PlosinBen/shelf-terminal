import type { ProjectView } from './store-projects';

/** App holds the per-Project update queue across this entire operation, including
 * retries. Candidate ids are captured before enqueueing, never newly allocated
 * Views whose runtime mount may still be pending. Unknown history is not scanned. */
export async function collectUnusedAgentViews(
  projectId: string,
  candidates: readonly string[],
  deps: {
    getProject: (id: string) => ProjectView | null | undefined;
    clear: (sessionId: string) => Promise<void>;
    forget: (projectId: string, sessionId: string) => Promise<void>;
    settle: (sessionId: string) => Promise<void>;
  },
): Promise<void> {
  for (const sessionId of candidates) {
    const project = deps.getProject(projectId);
    if (!project) return; // Project deletion owns all its sessions.
    if (!Object.hasOwn(project.agentViews, sessionId)) continue; // Already collected.
    if (project.defaultTabs.some(tab => tab.kind === 'agent' && tab.sessionId === sessionId)
      || project.tabs.some(tab => tab.type === 'agent' && tab.sessionId === sessionId)) continue;
    await deps.settle(sessionId);
    // Keep the canonical record until history deletion succeeds: it is both
    // ownership evidence and the retry inventory after cancellation/restart.
    await deps.clear(sessionId);
    await deps.forget(projectId, sessionId);
  }
}
