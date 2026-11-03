import { randomUUID } from 'node:crypto';
import type { AgentViewConfig } from '@shared/projects';
import type { TabTemplate } from '@shared/types';

export function newAgentView(views: Readonly<Record<string, AgentViewConfig>>, provider: string) {
  if (typeof provider !== 'string' || !provider.trim()) throw new Error('Invalid Agent provider');
  const sessionId = randomUUID();
  if (Object.hasOwn(views, sessionId)) throw new Error(`Duplicate generated Agent session ${sessionId}`);
  return { sessionId, views: { ...views, [sessionId]: { provider, prefs: {} } } };
}

/** Editor/create drafts materialize atomically, never by mutating background prefs. */
export function materializeAgentDefaults(tabs: readonly TabTemplate[], initial: Readonly<Record<string, AgentViewConfig>>) {
  let views = { ...initial };
  const seen = new Set<string>();
  const defaults = tabs.map(tab => {
    if (tab.kind !== 'agent') return tab;
    let sessionId = tab.sessionId;
    if (sessionId && !Object.hasOwn(views, sessionId)) throw new Error(`Unknown Agent session ${sessionId}`);
    if (!sessionId || views[sessionId].provider !== tab.provider) {
      const created = newAgentView(views, tab.provider);
      views = created.views;
      sessionId = created.sessionId;
    }
    if (seen.has(sessionId)) throw new Error(`Duplicate Agent Default session ${sessionId}`);
    seen.add(sessionId);
    return { ...tab, sessionId };
  });
  return { defaultTabs: defaults, agentViews: views };
}
