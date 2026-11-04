import { useSyncExternalStore } from 'react';
import type { DelegationSnapshot, DelegationPicker } from '@shared/agent-delegation';

interface State { entries: DelegationSnapshot[]; pickers: DelegationPicker[]; busy: string[]; error: string | null }
let state: State = { entries: [], pickers: [], busy: [], error: null };
const listeners = new Set<() => void>();
const get = () => state;
function update(patch: Partial<State>) { state = { ...state, ...patch }; for (const listener of listeners) listener(); }
export const getDelegations = get;
export function useDelegations() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, get);
}
export function setDelegations(entries: DelegationSnapshot[]) { update({ entries }); }
export function enqueueDelegationPicker(request: DelegationPicker) {
  if (state.pickers.some(p => p.requestId === request.requestId)) return;
  update({ pickers: [...state.pickers, request] });
}
export function removeDelegationPicker(requestId: string) { update({ pickers: state.pickers.filter(p => p.requestId !== requestId) }); }
export function setDelegationBusy(id: string, busy: boolean) {
  update({ busy: busy ? [...new Set([...state.busy, id])] : state.busy.filter(value => value !== id) });
}
export function setDelegationError(error: string | null) { update({ error }); }
