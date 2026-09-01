import { PTY_INIT_PRESENTATION_PHASE, type PtyInitPresentationPhase } from '@shared/types';
import { emitStoreChange } from './store-core';

export interface TerminalLifecycleSliceSnapshot {
  terminalInitPhases: Readonly<Record<string, PtyInitPresentationPhase>>;
}

let terminalInitPhases: Record<string, PtyInitPresentationPhase> = {};

export function getTerminalLifecycleSliceSnapshot(): TerminalLifecycleSliceSnapshot {
  return { terminalInitPhases };
}

export function initializeTerminalLifecycle(tabId: string): void {
  setTerminalInitPhase(tabId, PTY_INIT_PRESENTATION_PHASE.initializing);
}

export function setTerminalInitPhase(tabId: string, phase: PtyInitPresentationPhase): void {
  if (terminalInitPhases[tabId] === phase) return;
  terminalInitPhases = { ...terminalInitPhases, [tabId]: phase };
  emitStoreChange();
}

export function clearTerminalLifecycle(tabId: string): void {
  if (!(tabId in terminalInitPhases)) return;
  const next = { ...terminalInitPhases };
  delete next[tabId];
  terminalInitPhases = next;
  emitStoreChange();
}

export function resetTerminalLifecycleStoreForTests(): void {
  terminalInitPhases = {};
}
