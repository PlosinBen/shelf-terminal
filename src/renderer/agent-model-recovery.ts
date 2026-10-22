import { AgentInitRecoveryKind, type AgentInitRecovery } from '@shared/agent-init-recovery';
import type { Project } from '@shared/projects';
import type { AgentTabState } from './agentTabStore';
import { debugLog } from './debugLog';
import { ProjectMutationRefreshError } from './project-mutation-coordinator';

interface RecoveryDependencies {
  project(tabId: string): Project | undefined;
  tab(tabId: string): AgentTabState | undefined;
  save(projectId: string, changes: Partial<Omit<Project, 'id'>>): Promise<void>;
  refresh(): Promise<void>;
  status(tabId: string, state: 'starting' | 'failed', error?: string, recovery?: AgentInitRecovery): void;
  restart(tabId: string, tab: AgentTabState, project: Project): void;
}

/** App owns the side effects; this transaction keeps persistence ahead of init. */
export function createModelRecovery(deps: RecoveryDependencies) {
  const pending = new Set<string>();
  return async (tabId: string, clearModel = true): Promise<void> => {
    const tab = deps.tab(tabId);
    const project = deps.project(tabId);
    const recovery = tab?.initRecovery;
    if (!tab || !project) {
      debugLog('agent-recovery', `ignored retry for removed tab/project tabId=${tabId}`);
      return;
    }
    if (tab.initStatus === 'starting') return;
    if (clearModel && (tab.initStatus !== 'failed'
      || recovery?.kind !== AgentInitRecoveryKind.CLEAR_SAVED_MODEL)) return;
    const key = JSON.stringify([project.id, tab.provider]);
    if (pending.has(key)) return;
    pending.add(key);
    const current = () => {
      const nextTab = deps.tab(tabId);
      const nextProject = deps.project(tabId);
      return nextTab?.sessionId === tab.sessionId && nextTab.provider === tab.provider
        && nextTab.initStatus === 'starting' && nextProject?.id === project.id
        ? { tab: nextTab, project: nextProject } : undefined;
    };
    deps.status(tabId, 'starting');
    try {
      if (!clearModel) {
        // A previous attempt may have saved successfully but failed to refresh.
        await deps.refresh();
      } else if (project.agentPrefs[tab.provider]?.model === recovery!.model) {
        const prefs = { ...project.agentPrefs[tab.provider] };
        delete prefs.model;
        try {
          await deps.save(project.id, { agentPrefs: { ...project.agentPrefs, [tab.provider]: prefs } });
        } catch (error) {
          if (!(error instanceof ProjectMutationRefreshError)) throw error;
          // The deletion is already on disk. Refresh rather than repeat a stale save.
          await deps.refresh();
        }
      } else {
        debugLog('agent-recovery', `saved model changed; retrying latest intent tabId=${tabId} projectId=${project.id}`);
      }
      const next = current();
      if (!next) {
        debugLog('agent-recovery', `discarded stale operation tabId=${tabId} projectId=${project.id}`);
        return;
      }
      deps.restart(tabId, next.tab, next.project);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[agent-recovery] could not prepare retry', { tabId, projectId: project.id, reason });
      const next = current();
      if (next) deps.status(tabId, 'failed', `Could not prepare retry: ${reason}`, recovery);
    } finally {
      pending.delete(key);
    }
  };
}
