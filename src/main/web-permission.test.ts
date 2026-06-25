import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { IPC } from '@shared/ipc-channels';

// ── Mocks for the electron / away / telegram seams ──
const sentIpc: Array<{ channel: string; payload: any }> = [];
const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, payload: any) => sentIpc.push({ channel, payload }) },
};
let hasWindow = true;

let away = false;
const awayCbs: Array<(on: boolean) => void> = [];

let telegramAvailable = true;
const tgSends: Array<{ text: string; onAnswer: (v: string) => void }> = [];
const tgCancels: string[] = [];

const ipcHandlers: Record<string, (e: unknown, payload: unknown) => void> = {};

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => { ipcHandlers[ch] = fn; } },
}));
vi.mock('./app-state', () => ({ getMainWindow: () => (hasWindow ? fakeWin : null) }));
vi.mock('./pm/away-mode', () => ({
  isAwayMode: () => away,
  onAwayModeChange: (cb: (on: boolean) => void) => { awayCbs.push(cb); return () => {}; },
}));
vi.mock('./pm/telegram', () => ({
  isTelegramAvailable: () => telegramAvailable,
  sendInteractivePrompt: async (text: string, _opts: unknown, onAnswer: (v: string) => void) => {
    tgSends.push({ text, onAnswer });
    return 'ip1';
  },
  cancelInteractivePrompt: async (promptId: string) => { tgCancels.push(promptId); },
}));

const { requestWebPermission, registerWebPermissionHandlers } = await import('./web-permission');

const META = { origin: 'https://kibana.corp.com', registrableDomain: 'corp.com', method: 'GET' };

function lastRequestId(): string {
  const req = [...sentIpc].reverse().find((m) => m.channel === IPC.WEB_PERMISSION_REQUEST);
  return req!.payload.requestId;
}

beforeAll(() => { registerWebPermissionHandlers(); });

beforeEach(() => {
  sentIpc.length = 0; tgSends.length = 0; tgCancels.length = 0;
  away = false; telegramAvailable = true; hasWindow = true;
});

describe('web-permission', () => {
  it('shows the desktop popup and resolves from the renderer answer', async () => {
    const p = requestWebPermission(META);
    expect(sentIpc.find((m) => m.channel === IPC.WEB_PERMISSION_REQUEST)?.payload.origin).toBe(META.origin);

    const requestId = lastRequestId();
    ipcHandlers[IPC.WEB_PERMISSION_RESOLVE](null, { requestId, decision: 'always' });

    await expect(p).resolves.toBe('always');
    // local popup dismissed
    expect(sentIpc.some((m) => m.channel === IPC.WEB_PERMISSION_CLOSE && m.payload.requestId === requestId)).toBe(true);
  });

  it('routes to Telegram when Away and resolves from the Telegram answer', async () => {
    away = true;
    const p = requestWebPermission(META);
    expect(tgSends).toHaveLength(1);
    expect(tgSends[0].text).toContain(META.origin);

    tgSends[0].onAnswer('once');
    await expect(p).resolves.toBe('once');
  });

  it('re-delivers a pending request to Telegram when Away flips on', async () => {
    const p = requestWebPermission(META); // not away → no telegram yet
    expect(tgSends).toHaveLength(0);

    away = true;
    awayCbs.forEach((cb) => cb(true)); // simulate the away flip

    expect(tgSends).toHaveLength(1);
    tgSends[0].onAnswer('deny');
    await expect(p).resolves.toBe('deny');
  });

  it('fails closed (deny) when there is no window and no Telegram route', async () => {
    hasWindow = false; telegramAvailable = false; away = false;
    await expect(requestWebPermission(META)).resolves.toBe('deny');
  });

  it('times out to deny when nobody answers', async () => {
    vi.useFakeTimers();
    try {
      const p = requestWebPermission(META);
      vi.advanceTimersByTime(5 * 60_000 + 1);
      await expect(p).resolves.toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });
});
