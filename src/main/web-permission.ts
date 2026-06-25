import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { getMainWindow } from './app-state';
import { log } from '@shared/logger';
import { isAwayMode, onAwayModeChange } from './pm/away-mode';
import { isTelegramAvailable, sendInteractivePrompt, cancelInteractivePrompt } from './pm/telegram';
import type { WebPermissionMeta } from '@shared/web-session';

// Generic "main needs a user decision about web.fetch" channel. DECOUPLED from
// the agent tool-permission path: the request originates at the resource layer
// (handleAppTool → web session), so it's provider-agnostic.
//
// Delivery is a property of the PENDING request, not a one-shot at creation:
//   - always show the desktop popup (user may be at the keyboard)
//   - if Away (and Telegram is reachable), ALSO route to Telegram inline buttons
//   - if Away flips ON while a request is pending, re-deliver it to Telegram
//   - first answer (any channel) wins; the others are withdrawn/dismissed
//   - a timeout is the last backstop so a never-answered prompt can't wedge the
//     agent turn forever (fail-closed → deny)

export type WebPermissionDecision = 'once' | 'always' | 'deny';

// Generous: a real user may take a while (esp. answering from Telegram). This is
// only the floor against "nobody ever answers" hanging the turn indefinitely.
const TIMEOUT_MS = 5 * 60_000;

interface Pending {
  meta: WebPermissionMeta;
  settle: (decision: WebPermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  telegramPromptId: string | null;
}

let seq = 0;
const pending = new Map<string, Pending>();

export function requestWebPermission(meta: WebPermissionMeta): Promise<WebPermissionDecision> {
  seq += 1;
  const requestId = `wp-${seq}`;

  return new Promise<WebPermissionDecision>((resolve) => {
    const timer = setTimeout(() => {
      log.error('web-permission', `request ${requestId} for ${meta.origin} timed out → deny`);
      finish(requestId, 'deny');
    }, TIMEOUT_MS);
    timer.unref?.();

    pending.set(requestId, { meta, settle: resolve, timer, telegramPromptId: null });

    const win = getMainWindow();
    const haveWindow = !!win && !win.isDestroyed();
    if (haveWindow) {
      win!.webContents.send(IPC.WEB_PERMISSION_REQUEST, { requestId, ...meta });
    }

    // Decide Telegram routing synchronously (the actual send is async).
    const willTelegram = isAwayMode() && isTelegramAvailable();
    if (willTelegram) routeToTelegram(requestId);

    // No desktop window AND no Telegram route → nobody can answer → fail-closed.
    if (!haveWindow && !willTelegram) {
      finish(requestId, 'deny');
    }
  });
}

function routeToTelegram(requestId: string): void {
  const p = pending.get(requestId);
  if (!p || p.telegramPromptId || !isTelegramAvailable()) return;
  const text = `🔒 *Agent web access*\nUse your logged-in session for\n\`${p.meta.method} ${p.meta.origin}\`?`;
  void sendInteractivePrompt(
    text,
    [
      { label: '✅ Allow once', value: 'once' },
      { label: '☑️ Always', value: 'always' },
      { label: '❌ Deny', value: 'deny' },
    ],
    (value) => finish(requestId, normalize(value)),
  ).then((promptId) => {
    const cur = pending.get(requestId);
    if (!cur) {
      // Already resolved before the send landed — withdraw the stray message.
      if (promptId) void cancelInteractivePrompt(promptId);
      return;
    }
    cur.telegramPromptId = promptId;
  });
}

function finish(requestId: string, decision: WebPermissionDecision): void {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  clearTimeout(p.timer);

  // Dismiss the desktop popup if it's still up.
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IPC.WEB_PERMISSION_CLOSE, { requestId });
  // Withdraw the Telegram prompt if it was posted and not the answering channel.
  if (p.telegramPromptId) void cancelInteractivePrompt(p.telegramPromptId, `Resolved: ${decision}`);

  p.settle(decision);
}

function normalize(value: string): WebPermissionDecision {
  return value === 'always' ? 'always' : value === 'once' ? 'once' : 'deny';
}

export function registerWebPermissionHandlers(): void {
  ipcMain.handle(IPC.WEB_PERMISSION_RESOLVE, (_e, payload: unknown) => {
    const { requestId, decision } = (payload ?? {}) as { requestId?: string; decision?: string };
    if (!requestId) return;
    finish(requestId, normalize(decision ?? 'deny'));
  });

  // Away transition: stepping away while a prompt is pending re-delivers it to
  // Telegram (the desktop popup alone would strand the agent if nobody returns).
  onAwayModeChange((on) => {
    if (!on) return;
    for (const requestId of pending.keys()) routeToTelegram(requestId);
  });
}
