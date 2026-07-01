import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { getMainWindow } from './app-state';
import { log } from '@shared/logger';
import type { BrowserOpenMeta, BrowserOpenDecision } from '@shared/web-session';

// "main needs the user to approve opening a visible Web tab" channel, for the
// browser_open bridge tool. Sibling of web-permission.ts, but deliberately
// SIMPLER and STRICTER:
//   - Open/Deny ONLY — no "remember"/grant, so a single approval can never
//     enable later BACKGROUND opens (the user's hard requirement).
//   - Desktop popup only — NO Telegram/Away routing: logging in requires the
//     user physically at the keyboard, so an Away user can't act on it anyway.
//   - A timeout is the last backstop so a never-answered prompt can't wedge the
//     agent turn forever (fail-closed → deny).
// Because each open is blocking + a per-call human click, the agent can't reach
// its 2nd browser_open until the 1st resolves → "open N tabs at once" is
// structurally impossible with no extra rate-limiting.

// Generous: a real user may take a while to decide. Only a floor against
// "nobody ever answers" hanging the turn indefinitely.
const TIMEOUT_MS = 5 * 60_000;

interface Pending {
  meta: BrowserOpenMeta;
  settle: (decision: BrowserOpenDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

let seq = 0;
const pending = new Map<string, Pending>();

export function requestBrowserOpen(meta: BrowserOpenMeta): Promise<BrowserOpenDecision> {
  seq += 1;
  const requestId = `bo-${seq}`;

  return new Promise<BrowserOpenDecision>((resolve) => {
    const timer = setTimeout(() => {
      log.error('browser-open', `request ${requestId} for ${meta.origin} timed out → deny`);
      finish(requestId, 'deny');
    }, TIMEOUT_MS);
    timer.unref?.();

    pending.set(requestId, { meta, settle: resolve, timer });

    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.WEB_BROWSER_OPEN_REQUEST, { requestId, ...meta });
    } else {
      // No window to ask → nobody can answer → fail-closed.
      finish(requestId, 'deny');
    }
  });
}

function finish(requestId: string, decision: BrowserOpenDecision): void {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  clearTimeout(p.timer);

  // Dismiss the desktop popup if it's still up (e.g. resolved by timeout).
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IPC.WEB_BROWSER_OPEN_CLOSE, { requestId });

  p.settle(decision);
}

/** Ask the renderer to open a Web tab (in `projectId`) navigated to `url`. */
export function openWebTab(projectId: string, url: string): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.WEB_OPEN_TAB, { projectId, url });
  } else {
    log.error('browser-open', `openWebTab: no window to open ${url}`);
  }
}

function normalize(value: string): BrowserOpenDecision {
  return value === 'open' ? 'open' : 'deny';
}

export function registerBrowserOpenHandlers(): void {
  ipcMain.handle(IPC.WEB_BROWSER_OPEN_RESOLVE, (_e, payload: unknown) => {
    const { requestId, decision } = (payload ?? {}) as { requestId?: string; decision?: string };
    if (!requestId) return;
    finish(requestId, normalize(decision ?? 'deny'));
  });
}
