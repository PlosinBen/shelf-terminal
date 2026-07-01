import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { IPC } from '@shared/ipc-channels';

// ── Mocks for the electron / window seams ──
const sentIpc: Array<{ channel: string; payload: any }> = [];
const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, payload: any) => sentIpc.push({ channel, payload }) },
};
let hasWindow = true;

const ipcHandlers: Record<string, (e: unknown, payload: unknown) => void> = {};

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => { ipcHandlers[ch] = fn; } },
}));
vi.mock('./app-state', () => ({ getMainWindow: () => (hasWindow ? fakeWin : null) }));

const { requestBrowserOpen, openWebTab, registerBrowserOpenHandlers } = await import('./browser-open');

const META = { url: 'https://kibana.corp.com/login', origin: 'https://kibana.corp.com', registrableDomain: 'corp.com', reason: 'need to read the deploy dashboard' };

function lastRequestId(): string {
  const req = [...sentIpc].reverse().find((m) => m.channel === IPC.WEB_BROWSER_OPEN_REQUEST);
  return req!.payload.requestId;
}

beforeAll(() => { registerBrowserOpenHandlers(); });

beforeEach(() => {
  sentIpc.length = 0;
  hasWindow = true;
});

describe('browser-open', () => {
  it('shows the popup with the parsed origin + full url and resolves "open"', async () => {
    const p = requestBrowserOpen(META);
    const req = sentIpc.find((m) => m.channel === IPC.WEB_BROWSER_OPEN_REQUEST)?.payload;
    expect(req.origin).toBe(META.origin);
    expect(req.url).toBe(META.url);
    expect(req.reason).toBe(META.reason);

    const requestId = lastRequestId();
    ipcHandlers[IPC.WEB_BROWSER_OPEN_RESOLVE](null, { requestId, decision: 'open' });

    await expect(p).resolves.toBe('open');
    // local popup dismissed
    expect(sentIpc.some((m) => m.channel === IPC.WEB_BROWSER_OPEN_CLOSE && m.payload.requestId === requestId)).toBe(true);
  });

  it('resolves "deny" from the renderer answer', async () => {
    const p = requestBrowserOpen(META);
    ipcHandlers[IPC.WEB_BROWSER_OPEN_RESOLVE](null, { requestId: lastRequestId(), decision: 'deny' });
    await expect(p).resolves.toBe('deny');
  });

  it('normalizes any unknown decision to deny (never accidentally opens)', async () => {
    const p = requestBrowserOpen(META);
    ipcHandlers[IPC.WEB_BROWSER_OPEN_RESOLVE](null, { requestId: lastRequestId(), decision: 'always' });
    await expect(p).resolves.toBe('deny');
  });

  it('fails closed (deny) when there is no window to ask', async () => {
    hasWindow = false;
    await expect(requestBrowserOpen(META)).resolves.toBe('deny');
  });

  it('times out to deny when nobody answers', async () => {
    vi.useFakeTimers();
    try {
      const p = requestBrowserOpen(META);
      vi.advanceTimersByTime(5 * 60_000 + 1);
      await expect(p).resolves.toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('openWebTab sends WEB_OPEN_TAB with the project + url', () => {
    openWebTab('proj-1', 'https://kibana.corp.com/app');
    const msg = sentIpc.find((m) => m.channel === IPC.WEB_OPEN_TAB)?.payload;
    expect(msg).toEqual({ projectId: 'proj-1', url: 'https://kibana.corp.com/app' });
  });
});
