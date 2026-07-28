// wireLogger — logs shipped to main over the wire ({type:'log'}). This is the
// normal path for agent-server diagnostics. `.channel(name)` routes to a named
// per-feature file at main (logs/<name>/); the bare methods use main's default
// log. There is deliberately NO stderr option here — use rawLogger for that.

import { emitWire } from './core';
import type { ServerLogLevel } from '../server-logger';

export interface Leveled {
  error(tag: string, msg: string, ...args: unknown[]): void;
  warn(tag: string, msg: string, ...args: unknown[]): void;
  info(tag: string, msg: string, ...args: unknown[]): void;
  debug(tag: string, msg: string, ...args: unknown[]): void;
}

function leveled(channel: string | undefined): Leveled {
  const at =
    (level: ServerLogLevel) =>
    (tag: string, msg: string, ...args: unknown[]) =>
      emitWire(level, tag, channel, msg, args);
  return { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
}

export const wireLogger: Leveled & { channel(name: string): Leveled } = {
  ...leveled(undefined),
  channel(name: string): Leveled {
    return leveled(name);
  },
};
