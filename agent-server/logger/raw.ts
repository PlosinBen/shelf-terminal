// rawLogger — stderr-only, the deliberate last resort for when the wire is dead
// (main gone / not pinging) or before the sink is wired. No channel: stderr has
// no files, and the type reflects that (rawLogger has no `.channel`). Importing
// rawLogger in a file signals "this path can log without main".

import { fmt } from './core';
import type { ServerLogLevel } from '../server-logger';
import type { Leveled } from './wire';

function rawAt(level: ServerLogLevel) {
  return (tag: string, msg: string, ...args: unknown[]) => {
    const text = args.length ? `${msg} ${args.map(fmt).join(' ')}` : msg;
    process.stderr.write(`[${level}][${tag}] ${text}\n`);
  };
}

export const rawLogger: Leveled = {
  error: rawAt('error'),
  warn: rawAt('warn'),
  info: rawAt('info'),
  debug: rawAt('debug'),
};
