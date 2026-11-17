import { useSyncExternalStore } from 'react';
import type { SkillCommandDraft, SkillCommandResult, SkillCommandRegistration } from '@shared/skill-commands';

interface DraftState {
  loaded: boolean;
  enabled: boolean;
  alias: string;
  description: string;
  baseline: SkillCommandDraft | null;
  metadataError: string | null;
  uncertain: boolean;
}
const empty = (): DraftState => ({ loaded: false, enabled: false, alias: '', description: '', baseline: null, metadataError: null, uncertain: false });
let state = empty();
const listeners = new Set<() => void>();
function change(patch: Partial<DraftState>) { state = { ...state, ...patch }; for (const listener of listeners) listener(); }
export function useSkillCommandDraft() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => state);
}
export function resetSkillCommandDraft() { state = empty(); for (const listener of listeners) listener(); }
export function loadSkillCommandDraft(result: SkillCommandResult<SkillCommandRegistration | null>, name: string, description: string) {
  if (!result.ok) {
    change({ loaded: true, enabled: true, alias: name, description, baseline: null, metadataError: result.error, uncertain: false });
  } else {
    const command = result.value;
    change({ loaded: true, enabled: command !== null, alias: command?.alias ?? name, description: command?.description ?? description, baseline: command, metadataError: null, uncertain: false });
  }
}
export function editSkillCommandDraft(patch: Partial<Pick<DraftState, 'enabled' | 'alias' | 'description'>>) { change(patch); }
export function peekSkillCommandDraft(): SkillCommandDraft | null {
  return state.enabled ? { alias: state.alias, description: state.description } : null;
}
export function isSkillCommandDirty(): boolean {
  if (!state.loaded) return false;
  if (state.metadataError) return !state.enabled;
  const draft = peekSkillCommandDraft();
  return draft === null || state.baseline === null ? draft !== state.baseline : draft.alias !== state.baseline.alias || draft.description !== state.baseline.description;
}
export function markSkillCommandSaved(draft: SkillCommandDraft | null) {
  const normalized = draft ? { alias: draft.alias.trim(), description: draft.description.trim() } : null;
  change({ baseline: normalized, metadataError: null, ...(normalized ? normalized : {}) });
}
export function markSkillEditorUncertain() { change({ uncertain: true }); }
