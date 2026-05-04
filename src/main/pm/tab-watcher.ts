import type { TabInferredState } from '@shared/types';
import * as scrollback from './scrollback-buffer';
import { inferTabState } from './tools';
import { isAwayMode } from './away-mode';
import { log } from '@shared/logger';
import { getAgentState, isAgentTab } from '../agent';
import type { AgentSessionState } from '../agent/types';

interface TabState {
  state: TabInferredState;
  lastCheck: number;
}

const tabStates = new Map<string, TabState>();
const DEBOUNCE_MS = 2000;

type EventCallback = (tabId: string, tabName: string, projectName: string, oldState: TabInferredState, newState: TabInferredState) => void;

let onStateChange: EventCallback | null = null;

export function setStateChangeCallback(cb: EventCallback): void {
  onStateChange = cb;
}

interface TabMeta {
  tabId: string;
  tabName: string;
  projectName: string;
}

let knownTabs: TabMeta[] = [];

export function updateKnownTabs(tabs: TabMeta[]): void {
  knownTabs = tabs;
}

const INTERESTING_TRANSITIONS: [TabInferredState, TabInferredState][] = [
  ['cli_running', 'cli_waiting_permission'],
  ['cli_running', 'cli_error'],
  ['cli_running', 'cli_done'],
  ['cli_running', 'idle_shell'],
];

function isInteresting(from: TabInferredState, to: TabInferredState): boolean {
  return INTERESTING_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export function mapAgentState(agentState: AgentSessionState): TabInferredState {
  switch (agentState) {
    case 'idle': return 'idle_shell';
    case 'streaming': return 'cli_running';
    case 'waiting_permission': return 'cli_waiting_permission';
    case 'error': return 'cli_error';
    default: return 'idle_shell';
  }
}

function resolveTabState(tabId: string): TabInferredState {
  if (isAgentTab(tabId)) {
    const agentState = getAgentState(tabId);
    return agentState ? mapAgentState(agentState) : 'idle_shell';
  }
  const text = scrollback.has(tabId) ? scrollback.read(tabId, 20) : '';
  return inferTabState(text);
}

export function checkTab(tabId: string): void {
  if (!isAwayMode()) return;
  if (!isAgentTab(tabId) && !scrollback.has(tabId)) return;

  const now = Date.now();
  const prev = tabStates.get(tabId);
  if (prev && now - prev.lastCheck < DEBOUNCE_MS) return;

  const newState = resolveTabState(tabId);
  const oldState = prev?.state ?? 'idle_shell';

  tabStates.set(tabId, { state: newState, lastCheck: now });

  if (oldState !== newState && isInteresting(oldState, newState) && onStateChange) {
    const meta = knownTabs.find((t) => t.tabId === tabId);
    if (meta) {
      log.info('pm-watcher', `tab ${meta.tabName} (${meta.projectName}): ${oldState} → ${newState}`);
      onStateChange(tabId, meta.tabName, meta.projectName, oldState, newState);
    }
  }
}

export function removeTab(tabId: string): void {
  tabStates.delete(tabId);
}

export function clearAll(): void {
  tabStates.clear();
}

export interface TabSnapshot {
  tabId: string;
  tabName: string;
  projectName: string;
  state: TabInferredState;
}

export function snapshotTabs(): TabSnapshot[] {
  return knownTabs.map((meta) => ({
    tabId: meta.tabId,
    tabName: meta.tabName,
    projectName: meta.projectName,
    state: resolveTabState(meta.tabId),
  }));
}
