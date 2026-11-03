import { CONFIG_EDIT_KEYS, type ConfigEditKey } from '@shared/config-ack';
import { PROJECT_EDIT_FIELD, PROJECT_EDIT_FIELDS, PROJECT_MUTATION, sameProjectValue, type ProjectMutation, type ProjectMutationResult } from '@shared/project-mutations';
import type { Project } from '@shared/projects';
import { persistedPrefsFromCapabilities } from '@shared/agent-pref-report';
import { materializeAgentDefaults, newAgentView } from './agent-view-config';

function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid project mutation ${label}`);
}

/** Called only inside the repository's serialized latest-canonical boundary (projects#13). */
export function applyProjectMutation(current: Project, mutation: ProjectMutation):
  | { ok: true; project: Project; sessionId?: string }
  | Extract<ProjectMutationResult, { ok: false }> {
  if (!mutation || typeof mutation !== 'object') throw new Error('Invalid project mutation');
  if ('provider' in mutation) nonempty(mutation.provider, 'provider');
  if ('sessionId' in mutation) {
    nonempty(mutation.sessionId, 'sessionId');
    if (!Object.hasOwn(current.agentViews, mutation.sessionId)) throw new Error(`Unknown Agent session ${mutation.sessionId}`);
  }
  switch (mutation.kind) {
    case PROJECT_MUTATION.EDIT: {
      if (!Array.isArray(mutation.edits as unknown)) throw new Error('Project edits must be an array');
      const seen = new Set<string>();
      for (const edit of mutation.edits) {
        if (!edit || !PROJECT_EDIT_FIELDS.includes(edit.field) || seen.has(edit.field)
          || !Object.hasOwn(edit, 'before') || !Object.hasOwn(edit, 'value')) {
          throw new Error('Invalid or duplicate project edit field');
        }
        seen.add(edit.field);
      }
      const conflicts = mutation.edits.filter(edit =>
        !sameProjectValue(current[edit.field], edit.before)
        && !sameProjectValue(current[edit.field], edit.value)).map(edit => edit.field);
      if (conflicts.length) return { ok: false, conflicts };
      if (current.parentProjectId && mutation.edits.some(edit =>
        edit.field === PROJECT_EDIT_FIELD.FEATURE_NOTE_DIR && !sameProjectValue(edit.value, current.featureNoteDir))) {
        throw new Error('A worktree feature-note directory is read-only');
      }
      const candidate = { ...current, ...Object.fromEntries(mutation.edits.map(edit => [edit.field, edit.value])) };
      const layoutChanged = mutation.edits.some(edit => edit.field === PROJECT_EDIT_FIELD.DEFAULT_TABS);
      return { ok: true, project: layoutChanged
        ? { ...candidate, ...materializeAgentDefaults(candidate.defaultTabs, current.agentViews) } : candidate };
    }
    case PROJECT_MUTATION.AGENT_REPORT: {
      if (!mutation.report || typeof mutation.report !== 'object') throw new Error('Invalid agent preference report');
      const view = current.agentViews[mutation.sessionId];
      const partial = persistedPrefsFromCapabilities(mutation.report, view.prefs);
      for (const [key, value] of Object.entries(partial)) {
        if (!Object.values(CONFIG_EDIT_KEYS).includes(key as ConfigEditKey) || typeof value !== 'string') {
          throw new Error(`Invalid agent preference field ${key}`);
        }
      }
      if (Object.keys(partial).length === 0) return { ok: true, project: current };
      return { ok: true, project: { ...current, agentViews: {
        ...current.agentViews,
        [mutation.sessionId]: { ...view, prefs: { ...view.prefs, ...partial } },
      } } };
    }
    case PROJECT_MUTATION.CREATE_AGENT_VIEW: {
      const created = newAgentView(current.agentViews, mutation.provider);
      return { ok: true, sessionId: created.sessionId, project: { ...current, agentViews: created.views } };
    }
    case PROJECT_MUTATION.APPEND_DEFAULT_TAB: {
      if (!mutation.tab || typeof mutation.tab !== 'object') throw new Error('Invalid default tab');
      const tab = mutation.tab;
      if (tab.kind === 'agent') {
        if (!tab.sessionId || current.agentViews[tab.sessionId]?.provider !== tab.provider) throw new Error('Invalid Agent Default binding');
        if (current.defaultTabs.some(existing => existing.kind === 'agent' && existing.sessionId === tab.sessionId)) {
          return { ok: true, project: current };
        }
      }
      return { ok: true, project: { ...current, defaultTabs: [...current.defaultTabs, tab] } };
    }
    case PROJECT_MUTATION.CLEAR_AGENT_PREF: {
      if (!Object.values(CONFIG_EDIT_KEYS).includes(mutation.key)) throw new Error('Invalid saved preference key');
      nonempty(mutation.savedValue, 'savedValue');
      const view = current.agentViews[mutation.sessionId];
      if (view.prefs[mutation.key] !== mutation.savedValue) return { ok: true, project: current };
      const prefs = { ...view.prefs };
      delete prefs[mutation.key];
      return { ok: true, project: { ...current, agentViews: { ...current.agentViews, [mutation.sessionId]: { ...view, prefs } } } };
    }
    default:
      throw new Error('Unrecognized project mutation kind');
  }
}
