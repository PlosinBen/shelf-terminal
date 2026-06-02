import type { AgentInitStatus, AgentPrefs, Connection } from '../../shared/types';
import { on, emit } from './bus';

// Typed agent event vocabulary. Names prefixed 'agent:' to coexist with
// the untyped legacy events on the same bus.
//
// Inbound (IPC → bus): preload listeners convert window.shelfApi.agent.on*
// callbacks into emits on these names. agentTabStore.ts subscribes to
// them and updates per-tab state.
//
// Outbound (bus → IPC): InputZone / cycle handlers / decision panels
// emit these instead of calling window.shelfApi.agent.* directly. The
// IPC binder subscribes and forwards.
//
// Payloads carry tabId so a single global listener can route to the
// right tab slice without per-component (tabId === id) filtering.
export interface AgentEventMap {
  // -------- Inbound (IPC → bus) --------
  'agent:onMessage': { tabId: string; msg: unknown };
  'agent:onStream': { tabId: string; chunk: unknown };
  'agent:onStatus': { tabId: string; status: unknown };
  'agent:onPlan': { tabId: string; content: string };
  'agent:onCapabilities': { tabId: string; caps: unknown };
  'agent:onPermissionRequest': { tabId: string; req: unknown };
  'agent:onPickerRequest': { tabId: string; req: unknown };
  'agent:onAuthRequired': { tabId: string; provider: string };
  'agent:onInitStatus': { tabId: string; status: AgentInitStatus };

  // -------- Outbound (bus → IPC) --------
  'agent:init': {
    tabId: string;
    cwd: string;
    connection: Connection;
    provider: string;
    sessionId?: string;
    opts?: Record<string, unknown>;
  };
  'agent:send': {
    tabId: string;
    text: string;
    images?: string[];
    prefs?: AgentPrefs;
    /** Structured config edit (picker / status-bar). When set, text is empty
     *  and no user echo is written — the provider applies it + emits a divider. */
    configEdit?: { key: 'model' | 'effort' | 'permissionMode'; value: string };
  };
  'agent:stop': { tabId: string };
  'agent:destroy': { tabId: string };
  'agent:resolvePermission': {
    tabId: string;
    toolUseId: string;
    allow: boolean;
    scope?: 'once' | 'session';
  };
  'agent:resolvePicker': {
    tabId: string;
    pickerId: string;
    payload: { answers: Array<string | string[]> } | { cancelled: true };
  };
  'agent:checkAuth': { tabId: string };

  // -------- Internal (renderer-only, never crosses IPC) --------
  // Cross-component nudge for sibling components that don't share a
  // direct parent state. Sender (InputZone after send / AgentView
  // queue-flush) wants the message list to snap to bottom. Receiver
  // (MessageList) subscribes; if tabId matches, force-engage follow
  // and scroll. Renderer-only — not bound to any IPC channel.
  'agent:scrollToBottom': { tabId: string };
}

export type AgentEventName = keyof AgentEventMap;

// Typed wrappers — same Map under the hood, just narrows the names and
// payloads. Subscribers/emitters of legacy untyped events keep using
// on/emit from ./bus directly.
export function onAgent<K extends AgentEventName>(
  event: K,
  handler: (payload: AgentEventMap[K]) => void,
): () => void {
  return on(event, handler as (...args: any[]) => void);
}

export function emitAgent<K extends AgentEventName>(
  event: K,
  payload: AgentEventMap[K],
): void {
  emit(event, payload);
}
