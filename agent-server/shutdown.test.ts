import { describe, it, expect, vi } from 'vitest';
import { performShutdown } from './shutdown';
import type { ServerBackend, ReapableTask } from './providers/types';

function mkBackend(opts: {
  tasks?: ReapableTask[];
  stopTask?: (id: string) => Promise<void>;
  dispose?: () => void;
}): ServerBackend {
  return {
    listReapableTasks: opts.tasks ? vi.fn(async () => opts.tasks!) : undefined,
    stopTask: opts.tasks ? vi.fn(opts.stopTask ?? (async () => {})) : undefined,
    dispose: vi.fn(opts.dispose ?? (() => {})),
  } as unknown as ServerBackend;
}

const noopLog = () => {};

describe('performShutdown', () => {
  it('reaps running tasks, disposes all backends, then exits', async () => {
    const stop = vi.fn(async () => {});
    const b = mkBackend({ tasks: [{ id: 'a', kind: 'shell', status: 'running' }], stopTask: stop });
    const exit = vi.fn();
    await performShutdown({ backends: [b], reapTimeoutMs: 1000, log: noopLog, exit });
    expect(stop).toHaveBeenCalledWith('a');
    expect((b as any).dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('still disposes + exits when the reap hangs past the timeout', async () => {
    // stopTask never resolves → reap would hang forever; the timeout must let us proceed.
    const b = mkBackend({
      tasks: [{ id: 'x', kind: 'shell', status: 'running' }],
      stopTask: () => new Promise<void>(() => { /* never resolves */ }),
    });
    const exit = vi.fn();
    const log = vi.fn();
    await performShutdown({ backends: [b], reapTimeoutMs: 20, log, exit });
    expect((b as any).dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('timed out'));
  });

  it('a backend whose dispose throws does not block the others or exit', async () => {
    const good = mkBackend({});
    const bad = mkBackend({ dispose: () => { throw new Error('dispose boom'); } });
    const exit = vi.fn();
    await performShutdown({ backends: [bad, good], reapTimeoutMs: 100, log: noopLog, exit });
    expect((good as any).dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits even with no backends', async () => {
    const exit = vi.fn();
    await performShutdown({ backends: [], reapTimeoutMs: 100, log: noopLog, exit });
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
