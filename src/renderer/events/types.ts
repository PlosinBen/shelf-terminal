import type { AgentInitStatus, AgentLoginPrompt, AgentLoginResult, AgentQueueItem, Connection, TaskEvent } from '../../shared/types';
import { on, emit } from './bus';
import { SHELF_MCP, type ShelfMcpStatus } from '../../shared/shelf-mcp';

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
  [SHELF_MCP.STATUS_EVENT]: { tabId: string; status: ShelfMcpStatus };
  // -------- Inbound (IPC → bus) --------
  'agent:onMessage': { tabId: string; msg: unknown };
  'agent:onStream': { tabId: string; chunk: unknown };
  'agent:onStatus': { tabId: string; status: unknown };
  'agent:onPlan': { tabId: string; content: string };
  'agent:onBackgroundTasks': { tabId: string; event: TaskEvent };
  'agent:onQueue': { tabId: string; items: AgentQueueItem[] };
  'agent:onCapabilities': { tabId: string; caps: unknown };
  'agent:onPermissionRequest': { tabId: string; req: unknown };
  'agent:onPickerRequest': { tabId: string; req: unknown };
  'agent:onAuthRequired': { tabId: string; provider: string };
  'agent:onLoginPrompt': { tabId: string; prompt: AgentLoginPrompt };
  'agent:onLoginDone': { tabId: string; result: AgentLoginResult };
  'agent:onInitStatus': { tabId: string; status: AgentInitStatus };

  // Renderer intents, handled centrally by App (not forwarded to IPC).
  'agent:recoverPref': { tabId: string };
  'agent:retryInit': { tabId: string };

  // -------- Outbound (bus → IPC) --------
  'agent:init': {
    tabId: string;
    cwd: string;
    connection: Connection;
    provider: string;
    sessionId?: string;
    opts?: Record<string, unknown>;
  };
  'agent:send': { tabId: string } & import('../../shared/agent-input').AgentInputRequest;
  'agent:stop': { tabId: string };
  /** Cancel a specific not-yet-running queued message by clientMsgId. */
  'agent:cancelQueued': { tabId: string; clientMsgId: string };
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
  /** Open the provider's interactive auth CLI in a terminal beside this agent tab. */
  'agent:openAuthTerminal': {
    tabId: string;
    provider: string;
    command: string;
  };
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
