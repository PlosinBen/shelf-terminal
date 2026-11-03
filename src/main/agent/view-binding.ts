import type { Project } from '@shared/projects';

export function validateViewBinding(
  project: Project | null,
  sessionId: string | undefined,
  provider: string,
  tabId: string,
  live: Iterable<{ tabId: string; sessionId?: string; provider: string; projectId?: string }>,
) {
  if (!project || !sessionId || !Object.hasOwn(project.agentViews, sessionId)) {
    throw new Error(`Unknown Agent View projectId=${project?.id} sessionId=${sessionId}`);
  }
  const view = project.agentViews[sessionId];
  if (view.provider !== provider) throw new Error(`Agent provider mismatch projectId=${project.id} sessionId=${sessionId}`);
  for (const existing of live) {
    if (existing.tabId === tabId && (existing.sessionId !== sessionId || existing.provider !== provider || existing.projectId !== project.id)) {
      throw new Error(`Agent tab binding changed tabId=${tabId} sessionId=${sessionId}`);
    }
    if (existing.tabId !== tabId && existing.sessionId === sessionId) {
      throw new Error(`Agent View already mounted sessionId=${sessionId} tabId=${existing.tabId}`);
    }
  }
  return view;
}
