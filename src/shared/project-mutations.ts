import type { ConfigEditKey } from './config-ack';
import type { Project } from './projects';
import type { AgentPrefs, TabTemplate } from './types';
import type { PermissionControlCapabilities } from './permission-controls';

export const PROJECT_MUTATION = {
  EDIT: 'edit',
  AGENT_REPORT: 'agent-report',
  CREATE_AGENT_VIEW: 'create-agent-view',
  APPEND_DEFAULT_TAB: 'append-default-tab',
  CLEAR_AGENT_PREF: 'clear-agent-pref',
} as const;

export const PROJECT_EDIT_FIELD = {
  NAME: 'name', INIT_SCRIPT: 'initScript', DEFAULT_TABS: 'defaultTabs',
  QUICK_COMMANDS: 'quickCommands', ENV_PLAIN: 'envPlain', FEATURE_NOTE_DIR: 'featureNoteDir',
} as const satisfies Record<string, keyof Project>;
export const PROJECT_EDIT_FIELDS = Object.values(PROJECT_EDIT_FIELD);
export type ProjectEditField = typeof PROJECT_EDIT_FIELDS[number];
export type ProjectEditValues = Pick<Project, ProjectEditField>;
export type ProjectFieldEdit = {
  [K in ProjectEditField]: { field: K; before: Project[K]; value: Project[K] }
}[ProjectEditField];

/** Provider-neutral capabilities already exposed by Shelf's backend boundary. */
export interface AgentPreferenceReport {
  confirmedPrefs?: Partial<AgentPrefs>;
  permissionControl?: PermissionControlCapabilities;
  currentModel?: string;
  currentEffort?: string;
  currentPermissionMode?: string;
}

export type ProjectMutation =
  | { kind: typeof PROJECT_MUTATION.EDIT; edits: readonly ProjectFieldEdit[] }
  | { kind: typeof PROJECT_MUTATION.AGENT_REPORT; sessionId: string; report: AgentPreferenceReport }
  | { kind: typeof PROJECT_MUTATION.CREATE_AGENT_VIEW; provider: string }
  | { kind: typeof PROJECT_MUTATION.APPEND_DEFAULT_TAB; tab: TabTemplate }
  | { kind: typeof PROJECT_MUTATION.CLEAR_AGENT_PREF; sessionId: string; key: ConfigEditKey; savedValue: string };

export type ProjectMutationResult =
  | { ok: true; sessionId?: string }
  | { ok: false; conflicts: readonly ProjectEditField[] };

/** JSON-domain structural equality, independent of record insertion order. */
export function sameProjectValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
  const keysA = Object.keys(a).filter(key => (a as Record<string, unknown>)[key] !== undefined);
  const keysB = Object.keys(b).filter(key => (b as Record<string, unknown>)[key] !== undefined);
  return keysA.length === keysB.length && keysA.every(key =>
    keysB.includes(key) && sameProjectValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export function projectEditValues(project: Project): ProjectEditValues {
  return Object.fromEntries(PROJECT_EDIT_FIELDS.map(field => [field, project[field]])) as ProjectEditValues;
}

export function projectFieldEdits(before: ProjectEditValues, value: ProjectEditValues): ProjectFieldEdit[] {
  return PROJECT_EDIT_FIELDS.filter(field => !sameProjectValue(before[field], value[field]))
    .map(field => ({ field, before: before[field], value: value[field] }) as ProjectFieldEdit);
}
