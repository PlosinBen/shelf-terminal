// PM-side handlers for raw PTY signals (architecture-health P1-1).
//
// pty-manager (terminal infra) reports output/lifecycle to an injected
// PtyObserver; these are the PM feature's handlers for that observer. The
// composition root (index.ts) wires them in via setPtyObserver(). This module
// deliberately does NOT import pty-manager — the dependency is feature→infra,
// established only at the wiring site, so the two modules stay mutually unaware.
import * as scrollback from './scrollback-buffer';
import { checkTab, removeTab, clearAll } from './tab-watcher';

/** PTY output chunk → feed scrollback, then re-evaluate tab state. Order
 *  matters: tab-watcher reads scrollback, so append must run first. */
export function handlePtyData(tabId: string, data: string): void {
  scrollback.append(tabId, data);
  checkTab(tabId);
}

/** Single tab killed → drop its scrollback + watcher state. */
export function handlePtyRemove(tabId: string): void {
  scrollback.remove(tabId);
  removeTab(tabId);
}

/** All tabs killed → wipe scrollback + watcher state. */
export function handlePtyClear(): void {
  scrollback.clear();
  clearAll();
}
