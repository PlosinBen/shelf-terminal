import type { TabType } from '@shared/types';
import { disposeTerminal } from './components/TerminalView';
import { removeTab as removeAgentTabState } from './agentTabStore';

/** Minimal tab shape needed to release its backend/OS resources. */
export interface TeardownTab {
  id: string;
  type: TabType;
  sessionId?: string;
}

const settlingAgentViews = new Map<string, Promise<void>>();

export function waitForAgentViewTeardown(sessionId: string): Promise<void> {
  return settlingAgentViews.get(sessionId) ?? Promise.resolve();
}

/**
 * Release the backend / OS resources a tab owns, by type. SINGLE SOURCE OF
 * TRUTH for tab teardown — every tab-removal path (close tab, remove project,
 * disconnect project) MUST route through here so none can drift.
 *
 * This exists because a drifted copy caused a real leak: the DISCONNECT_PROJECT
 * handler only killed PTYs and forgot `agent.destroy`, so disconnecting a
 * project with agent tabs left the agent-server exec process (and its provider
 * CLI child) alive forever.
 *
 * - `agent`  → destroy the backend session and remove renderer tab state.
 * - `terminal` → kill the PTY + dispose the xterm instance.
 * - `web`    → nothing: the <webview> tears down on unmount.
 */
export function teardownTab(tab: TeardownTab): Promise<void> {
  if (tab.type === 'agent') {
    const settled = Promise.all([
      window.shelfApi.agent.destroy(tab.id),
      removeAgentTabState(tab.id),
    ]).then(() => {});
    if (tab.sessionId) {
      const sessionId = tab.sessionId;
      settlingAgentViews.set(sessionId, settled);
      void settled.then(() => {
        if (settlingAgentViews.get(sessionId) === settled) settlingAgentViews.delete(sessionId);
      }, () => { /* Keep a failed teardown blocking collection until restart. */ });
    }
    void settled.catch(error => console.error('[agent-view] teardown failed; history retained', { tabId: tab.id, error }));
    return settled;
  } else if (tab.type === 'terminal') {
    window.shelfApi.pty.kill(tab.id);
    disposeTerminal(tab.id);
  }
  return Promise.resolve();
}
