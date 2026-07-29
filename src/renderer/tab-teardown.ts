import type { TabType } from '@shared/types';
import { disposeTerminal } from './components/TerminalView';
import { removeTab as removeAgentTabState } from './agentTabStore';

/** Minimal tab shape needed to release its backend/OS resources. */
export interface TeardownTab {
  id: string;
  type: TabType;
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
export function teardownTab(tab: TeardownTab): void {
  if (tab.type === 'agent') {
    window.shelfApi.agent.destroy(tab.id);
    removeAgentTabState(tab.id);
  } else if (tab.type === 'terminal') {
    window.shelfApi.pty.kill(tab.id);
    disposeTerminal(tab.id);
  }
}
