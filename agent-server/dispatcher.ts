// Per-host dispatcher process (dispatch-layering, group D). A THIN broker between
// main and the per-session exec procs. It multiplexes main's N sids onto N exec
// procs and relays streams OPAQUELY: exec procs stamp their own `sid` on every
// outbound line (spawned with `--sid`), so the dispatcher line-forwards exec→main
// RAW — it never parses the hot token stream. It only parses the low-volume
// INBOUND control/session messages to route them by sid.
//
// Imports NO provider / SDK modules (those live in exec.ts, loaded only in the
// exec role) → this process stays thin. Built incrementally: D2 = relay +
// open/close_session (this file). D3 = main-side wiring. D4 = two-tier health +
// supervisor. See the feature note.
import * as readline from 'readline';
import { spawn } from 'child_process';

/** A spawned per-session exec proc, from the dispatcher's side. */
export interface ExecProc {
  /** Forward a raw line to the exec proc's stdin. */
  writeLine(line: string): void;
  /** Graceful teardown (stdin EOF → the exec self-exits, verified cascade). */
  kill(): void;
}

export interface DispatcherDeps {
  /** Spawn an exec proc for `sid`. `onLine` gets each exec stdout line (already
   *  sid-stamped → relayed raw); `onExit` fires when it exits. */
  spawnExec: (
    sid: string,
    cwd: string | undefined,
    hooks: { onLine: (line: string) => void; onExit: (code: number | null) => void },
  ) => ExecProc;
  /** Write one raw line to main (the dispatcher's stdout). */
  sendToMain: (line: string) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface Dispatcher {
  /** Handle one inbound line from main. */
  onMainLine(line: string): void;
  /** Tear down all exec procs (main disconnected / dispatcher shutting down). */
  shutdown(): void;
}

/**
 * Pure orchestration (deps injected → unit-testable without real child procs or
 * stdio). Control messages (`open_session`/`close_session`/`ping`) are serviced
 * here; every other message carries `sid` and is FORWARDED RAW to that sid's exec
 * proc. Exec→main traffic is relayed raw by the spawn hooks, never touched here.
 */
export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const execs = new Map<string, ExecProc>();

  function onMainLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      deps.log('warn', 'dropping non-JSON line from main');
      return;
    }
    const type = msg?.type;
    const sid = msg?.sid;

    if (type === 'open_session') {
      if (typeof sid !== 'string') {
        deps.log('error', 'open_session without sid');
        return;
      }
      if (execs.has(sid)) {
        // A repeat open for a live sid is a benign race (main retried) — ignore.
        deps.log('warn', `open_session for already-open sid ${sid}`);
        return;
      }
      const proc = deps.spawnExec(sid, typeof msg.cwd === 'string' ? msg.cwd : undefined, {
        onLine: (l) => deps.sendToMain(l), // raw relay (exec already stamped sid)
        onExit: (code) => {
          execs.delete(sid);
          // D2: no respawn yet — tell main the session is gone (fail-loud, not
          // silent). D4 turns this into supervised auto-respawn (willRespawn:true).
          deps.sendToMain(JSON.stringify({ type: 'session_down', sid, reason: `exec exited (code ${code})`, willRespawn: false }));
        },
      });
      execs.set(sid, proc);
      return;
    }

    if (type === 'close_session') {
      if (typeof sid !== 'string') return;
      const proc = execs.get(sid);
      if (proc) {
        execs.delete(sid);
        proc.kill();
      }
      return;
    }

    if (type === 'ping') {
      // Host-level heartbeat (dispatcher-owned; no sid). D4 adds the inner tier.
      deps.sendToMain(JSON.stringify({ type: 'pong', seq: msg.seq }));
      return;
    }

    // Any other message is session-scoped → forward RAW to its exec proc.
    if (typeof sid !== 'string') {
      deps.log('warn', `inbound ${type} without sid — dropped`);
      return;
    }
    const proc = execs.get(sid);
    if (!proc) {
      deps.log('warn', `inbound ${type} for unknown sid ${sid} — dropped`);
      return;
    }
    proc.writeLine(line); // exec ignores the extra sid; reads its own fields
  }

  function shutdown(): void {
    for (const proc of execs.values()) proc.kill();
    execs.clear();
  }

  return { onMainLine, shutdown };
}

/** Boot entry: wire the real stdin/stdout + child_process spawn and run. */
export function runDispatcher(): void {
  const dispatcher = createDispatcher({
    spawnExec: (sid, cwd, hooks) => {
      // Same node + same bundle, exec role, told its sid. Inherits our env — the
      // shell/initScript setup already ran when main spawned THIS dispatcher.
      const child = spawn(process.execPath, [process.argv[1], '--role=exec', `--sid=${sid}`], {
        cwd: cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      const out = readline.createInterface({ input: child.stdout!, terminal: false });
      out.on('line', hooks.onLine);
      // Surface exec stderr on our own stderr (main captures the dispatcher's).
      child.stderr?.on('data', (d) => process.stderr.write(d));
      child.on('exit', (code) => hooks.onExit(code));
      return {
        writeLine: (line) => child.stdin?.write(line + '\n'),
        kill: () => child.stdin?.end(),
      };
    },
    sendToMain: (line) => process.stdout.write(line + '\n'),
    log: (level, msg) => process.stderr.write(`[dispatcher] ${level}: ${msg}\n`),
  });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => dispatcher.onMainLine(line));
  rl.on('close', () => {
    // Main's write-end closed → tear down all exec procs (their stdin EOF cascades
    // to their CLIs) and exit. D4 adds the normal-closure reap + lease handling.
    dispatcher.shutdown();
    process.exit(0);
  });

  // Announce the dispatcher process is up (no sid = dispatcher-level, vs an exec's
  // sid-stamped `ready` which signals a specific session is ready).
  process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
}
