import { afterEach, expect, it, vi } from 'vitest';
import { createAppExitController, createAppExitBridge } from './app-exit';
import { APP_EXIT_DECISION } from '@shared/app-exit';

afterEach(() => vi.useRealTimers());

it('coalesces close/Quit requests and never commits before preparation succeeds', async () => {
  let finish!: () => void;
  const prepare = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const commit = vi.fn();
  const controller = createAppExitController({ prepare, cancel: vi.fn(), prompt: vi.fn(), quit: commit });
  const first = controller.request();
  const second = controller.request();
  expect(first).toBe(second);
  expect(commit).not.toHaveBeenCalled();
  finish(); await first;
  expect(commit).toHaveBeenCalledOnce();
  expect(controller.committed()).toBe(true);
});

it('retries real preparation after write failure, without shutdown on cancellation', async () => {
  const prepare = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
  const quit = vi.fn();
  const cancel = vi.fn();
  const prompt = vi.fn().mockResolvedValueOnce(APP_EXIT_DECISION.CANCEL).mockResolvedValue(APP_EXIT_DECISION.RETRY);
  const controller = createAppExitController({ prepare, cancel, prompt, quit });
  expect(await controller.request()).toBe(false);
  expect(quit).not.toHaveBeenCalled();
  expect(controller.committed()).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
  prepare.mockRejectedValueOnce(new Error('retry needed'));
  expect(await controller.request()).toBe(true);
  expect(prepare).toHaveBeenCalledTimes(3);
  expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ unresponsive: false }));
});

it('timeout never authorizes exit; only an explicit force choice can commit', async () => {
  vi.useFakeTimers();
  const quit = vi.fn();
  const prompt = vi.fn().mockResolvedValueOnce(APP_EXIT_DECISION.CANCEL).mockResolvedValueOnce(APP_EXIT_DECISION.FORCE);
  const controller = createAppExitController({ prepare: () => new Promise<void>(() => {}), cancel: vi.fn(), prompt, quit, timeoutMs: 20 });
  const first = controller.request();
  await vi.advanceTimersByTimeAsync(21);
  expect(await first).toBe(false);
  expect(quit).not.toHaveBeenCalled();
  const second = controller.request();
  await vi.advanceTimersByTimeAsync(21);
  expect(await second).toBe(true);
  expect(quit).toHaveBeenCalledOnce();
  expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ unresponsive: true }));
});

it('an install action uses the same gate and is not invoked on cancellation', async () => {
  const install = vi.fn();
  const controller = createAppExitController({ prepare: vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue(undefined), cancel: vi.fn(), prompt: async () => APP_EXIT_DECISION.CANCEL, quit: vi.fn() });
  await controller.request(install);
  expect(install).not.toHaveBeenCalled();
  await controller.request(install);
  expect(install).toHaveBeenCalledOnce();
});

it('only the current renderer and request id can acknowledge exit readiness', async () => {
  const send = vi.fn();
  const warn = vi.fn();
  const bridge = createAppExitBridge({ send, isCurrentSender: sender => sender === 'trusted', warn });
  const first = bridge.prepare('first');
  expect(bridge.accept('untrusted', { requestId: 'first', ok: true })).toBe(false);
  expect(bridge.accept('trusted', { requestId: 'old', ok: true })).toBe(false);
  expect(bridge.accept('trusted', { requestId: undefined, ok: true })).toBe(false);
  bridge.cancel('first');
  await expect(first).rejects.toThrow('cancelled');
  const second = bridge.prepare('second');
  expect(bridge.accept('trusted', { requestId: 'first', ok: true })).toBe(false);
  expect(bridge.accept('trusted', { requestId: 'second', ok: true })).toBe(true);
  await second;
  expect(warn).toHaveBeenCalledTimes(4);
});
