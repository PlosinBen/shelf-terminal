import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessMemorySummary } from '@shared/process-memory';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
}));

const send = vi.fn();
const isDestroyed = vi.fn(() => false);
vi.mock('../app-state', () => ({
  getMainWindow: () => ({ isDestroyed, webContents: { send } }),
}));

let sink: ((summary: ProcessMemorySummary) => void) | undefined;
const current = vi.fn<() => ProcessMemorySummary | null>();
vi.mock('../process-memory-manager', () => ({
  getCurrentProcessMemorySummary: () => current(),
  setProcessMemorySummarySink: (next: (summary: ProcessMemorySummary) => void) => { sink = next; },
}));

const { IPC } = await import('@shared/ipc-channels');
const { registerProcessMemoryHandlers } = await import('./process-memory');

const summary: ProcessMemorySummary = {
  summarizedAt: '2026-08-05T00:00:00.000Z',
  app: { availability: 'available', memoryKiB: 12, excludedSources: 0 },
  connections: {},
  tabs: {},
  excludedSourceCount: 0,
};

beforeEach(() => {
  handlers.clear();
  send.mockReset();
  isDestroyed.mockReset().mockReturnValue(false);
  current.mockReset().mockReturnValue(summary);
  sink = undefined;
  registerProcessMemoryHandlers();
});

describe('process memory IPC', () => {
  it('hydrates from the exact cached summary without resampling', () => {
    expect(handlers.get(IPC.AGENT_MEMORY_USAGE_CURRENT)?.()).toBe(summary);
    expect(current).toHaveBeenCalledOnce();
  });

  it('publishes the exact summary snapshot to a live renderer', () => {
    sink?.(summary);
    expect(send).toHaveBeenCalledWith(IPC.AGENT_MEMORY_USAGE, summary);
  });

  it('does not publish after the window is destroyed', () => {
    isDestroyed.mockReturnValue(true);
    sink?.(summary);
    expect(send).not.toHaveBeenCalled();
  });
});
