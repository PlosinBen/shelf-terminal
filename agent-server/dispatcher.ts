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
  /** Injectable clock (respawn backoff window); defaults to Date.now. */
  now?: () => number;
}

/** Restart-storm backoff: at most MAX respawns within WINDOW before giving up. */
const MAX_RESPAWNS = 5;
const RESPAWN_WINDOW_MS = 10_000;

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
  interface ExecEntry { proc: ExecProc; cwd: string | undefined; respawnAt: number[]; }
  const execs = new Map<string, ExecEntry>();
  const now = deps.now ?? (() => Date.now());

  /** Spawn an exec for `sid` and wire its relay + supervised exit. */
  function startExec(sid: string, cwd: string | undefined): ExecProc {
    return deps.spawnExec(sid, cwd, {
      onLine: (l) => deps.sendToMain(l), // raw relay (exec already stamped sid)
      onExit: (code) => handleExecExit(sid, code),
    });
  }

  /** Supervisor: on an exec exit, auto-respawn (replacing today's crash→wedge)
   *  unless it is crash-looping, in which case give up with a terminal down. */
  function handleExecExit(sid: string, code: number | null): void {
    const entry = execs.get(sid);
    if (!entry) return; // already closed intentionally (close_session)
    const t = now();
    entry.respawnAt = entry.respawnAt.filter((ts) => t - ts < RESPAWN_WINDOW_MS);
    if (entry.respawnAt.length >= MAX_RESPAWNS) {
      execs.delete(sid);
      deps.log('error', `exec ${sid} crash-looping (${MAX_RESPAWNS}/${RESPAWN_WINDOW_MS}ms) — giving up`);
      deps.sendToMain(JSON.stringify({ type: 'session_down', sid, reason: `crash-loop (code ${code})`, willRespawn: false }));
      return;
    }
    // Fail-loud: main is told the in-flight turn was lost + a respawn is coming
    // (willRespawn:true → recovering, not disconnected); the new exec's relayed
    // ready{sid} then signals recovery. Main surfaces the lost-turn error + cancels
    // that sid's open prompts (dispatcher-connection, #6).
    entry.respawnAt.push(t);
    deps.sendToMain(JSON.stringify({ type: 'session_down', sid, reason: `exec exited (code ${code})`, willRespawn: true }));
    entry.proc = startExec(sid, entry.cwd);
  }

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
      const cwd = typeof msg.cwd === 'string' ? msg.cwd : undefined;
      execs.set(sid, { proc: startExec(sid, cwd), cwd, respawnAt: [] });
      return;
    }

    if (type === 'close_session') {
      if (typeof sid !== 'string') return;
      const entry = execs.get(sid);
      if (entry) {
        execs.delete(sid); // delete BEFORE kill so handleExecExit sees no entry → no respawn
        entry.proc.kill();
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
    const entry = execs.get(sid);
    if (!entry) {
      deps.log('warn', `inbound ${type} for unknown sid ${sid} — dropped`);
      return;
    }
    entry.proc.writeLine(line); // exec ignores the extra sid; reads its own fields
  }

  function shutdown(): void {
    for (const entry of execs.values()) entry.proc.kill();
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
