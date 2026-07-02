import { describe, it, expect, vi } from 'vitest';
import { reapDetachedTasks } from './reaper';
import type { ServerBackend, ReapableTask } from './providers/types';

// The reaper only touches listReapableTasks + stopTask; cast a partial to the
// full ServerBackend shape.
function mkBackend(
  tasks: ReapableTask[] | Error,
  stopTask: (id: string) => Promise<void> = async () => {},
): ServerBackend {
  return {
    listReapableTasks: async () => {
      if (tasks instanceof Error) throw tasks;
      return tasks;
    },
    stopTask: vi.fn(stopTask),
  } as unknown as ServerBackend;
}

const noopLog = () => {};

describe('reapDetachedTasks', () => {
  it('reaps running tasks and skips terminal ones', async () => {
    const stop = vi.fn(async () => {});
    const b = mkBackend(
      [
        { id: 'a', kind: 'shell', status: 'running' },
        { id: 'b', kind: 'shell', status: 'done' },
        { id: 'c', kind: 'shell', status: 'running' },
      ],
      stop,
    );
    const summary = await reapDetachedTasks([b], noopLog);
    expect(summary).toEqual({ enumerated: 3, reaped: 2 });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledWith('a');
    expect(stop).toHaveBeenCalledWith('c');
    expect(stop).not.toHaveBeenCalledWith('b');
  });

  it('skips backends that do not implement both contract methods', async () => {
    const noList = { stopTask: vi.fn() } as unknown as ServerBackend;
    const noStop = { listReapableTasks: vi.fn() } as unknown as ServerBackend;
    const empty = {} as unknown as ServerBackend;
    const summary = await reapDetachedTasks([noList, noStop, empty], noopLog);
    expect(summary).toEqual({ enumerated: 0, reaped: 0 });
    expect((noStop as any).listReapableTasks).not.toHaveBeenCalled();
  });

  it('a throwing listReapableTasks on one backend does not block the others', async () => {
    const log = vi.fn();
    const good = mkBackend([{ id: 'x', kind: 'shell', status: 'running' }]);
    const bad = mkBackend(new Error('rpc down'));
    const summary = await reapDetachedTasks([bad, good], log);
    expect(summary).toEqual({ enumerated: 1, reaped: 1 });
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('listReapableTasks failed'));
    expect((good as any).stopTask).toHaveBeenCalledWith('x');
  });

  it('a throwing stopTask on one task does not block the next task', async () => {
    const log = vi.fn();
    const stop = vi.fn(async (id: string) => {
      if (id === 'a') throw new Error('kill failed');
    });
    const b = mkBackend(
      [
        { id: 'a', kind: 'shell', status: 'running' },
        { id: 'b', kind: 'shell', status: 'running' },
      ],
      stop,
    );
    const summary = await reapDetachedTasks([b], log);
    // enumerated both; only 'b' reaped successfully.
    expect(summary).toEqual({ enumerated: 2, reaped: 1 });
    expect(stop).toHaveBeenCalledWith('b');
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('stopTask(a) failed'));
  });

  it('reaps across multiple backends', async () => {
    const b1 = mkBackend([{ id: 'a', kind: 'shell', status: 'running' }]);
    const b2 = mkBackend([
      { id: 'b', kind: 'shell', status: 'running' },
      { id: 'c', kind: 'shell', status: 'done' },
    ]);
    const summary = await reapDetachedTasks([b1, b2], noopLog);
    expect(summary).toEqual({ enumerated: 3, reaped: 2 });
  });
});
