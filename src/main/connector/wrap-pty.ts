import type * as pty from 'node-pty';
import type { Shell, Disposable } from './types';

/** Wrap a node-pty IPty into our Shell interface. */
export function wrapPty(p: pty.IPty): Shell {
  return {
    onData(cb: (data: string) => void): Disposable {
      const d = p.onData(cb);
      return { dispose: () => d.dispose() };
    },
    onExit(cb: (exitCode: number) => void): Disposable {
      const d = p.onExit(({ exitCode }) => cb(exitCode));
      return { dispose: () => d.dispose() };
    },
    write(data: string) {
      p.write(data);
    },
    resize(cols: number, rows: number) {
      p.resize(cols, rows);
    },
    kill() {
      p.kill();
    },
  };
}
