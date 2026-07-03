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
import { createModelCache, type ModelCache } from './model-cache';

/** A spawned per-session exec proc, from the dispatcher's side. */
export interface ExecProc {
  /** Forward a raw line to the exec proc's stdin. */
  writeLine(line: string): void;
  /** Graceful teardown (stdin EOF → the exec self-exits, verified cascade). */
  kill(): void;
  /** Hard kill (SIGKILL) — an UNRESPONSIVE exec won't process stdin EOF, so the
   *  inner heartbeat force-kills it to trigger a reconnect. */
  forceKill(): void;
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
  /** Injectable clock (reconnect backoff window); defaults to Date.now. */
  now?: () => number;
  /** Per-host model/caps cache (group E). Serviced on the exec side-channel
   *  (cache_get/cache_put); absent → the side-channel no-ops (every exec fetches). */
  cache?: ModelCache;
  /** Called on each main heartbeat ping — runDispatcher resets its idle watchdog
   *  (ssh remote self-exit when main goes quiet). See F-a / connection-health#2. */
  onMainPing?: () => void;
}

/** Reconnect backoff: at most MAX reconnects within WINDOW before giving up. */
const MAX_RECONNECTS = 5;
const RECONNECT_WINDOW_MS = 10_000;
/** Inner heartbeat: an exec that misses this many consecutive pings is judged
 *  UNRESPONSIVE (force-killed → reconnected). */
const INNER_DEAD_MISSES = 3;

export interface Dispatcher {
  /** Handle one inbound line from main. */
  onMainLine(line: string): void;
  /** Inner heartbeat cycle: ping every exec + flag the hung ones. Called on a
   *  timer by runDispatcher; exposed so tests can drive it deterministically. */
  tick(): void;
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
  // Per session: the current exec connection + its cwd (to reconnect) + inner-
  // heartbeat state + the timestamps of recent reconnects (backoff window).
  interface ExecEntry { proc: ExecProc; cwd: string | undefined; reconnectAt: number[]; missed: number; unresponsive: boolean; }
  const execs = new Map<string, ExecEntry>();
  const now = deps.now ?? (() => Date.now());

  /** Open an exec execution for `sid` and wire its relay + down-handling. */
  function startExec(sid: string, cwd: string | undefined): ExecProc {
    return deps.spawnExec(sid, cwd, {
      onLine: (l) => handleExecLine(sid, l),
      onExit: (code) => handleExecDown(sid, `exited (code ${code})`),
    });
  }

  /**
   * Exec stdout: relayed RAW to main, EXCEPT dispatcher-serviced messages we peek
   * out. The peek is a cheap substring pre-filter so ordinary stream tokens stay
   * parse-free (they don't contain the marker) — only rare candidates are parsed.
   * Today only the inner-heartbeat `pong` is serviced here (E adds cache_get/put).
   */
  function handleExecLine(sid: string, line: string): void {
    if (line.includes('"type":"pong"')) {
      let p: any;
      try { p = JSON.parse(line); } catch { /* not really pong */ }
      if (p?.type === 'pong') {
        const entry = execs.get(sid);
        if (entry) { entry.missed = 0; entry.unresponsive = false; } // alive → reset
        return; // consume: the inner pong is dispatcher-internal, never relayed
      }
    }
    // Cache-aside side-channel (group E): serviced locally, never relayed to main.
    if (line.includes('"type":"cache_')) {
      let m: any;
      try { m = JSON.parse(line); } catch { /* not a cache message */ }
      if (m?.type === 'cache_get') {
        const value = deps.cache?.get(`${m.key}:${m.provider}`);
        execs.get(sid)?.proc.writeLine(JSON.stringify({ type: 'cache_reply', requestId: m.requestId, hit: value !== undefined, value }));
        return;
      }
      if (m?.type === 'cache_put') {
        deps.cache?.put(`${m.key}:${m.provider}`, m.value);
        return;
      }
    }
    deps.sendToMain(line); // relay raw (exec already stamped sid)
  }

  /**
   * The session's exec execution went DOWN (exited/crashed, or force-killed for
   * being unresponsive). There is no "respawn" in the worker-pool sense: the
   * dispatcher RECONNECTS the session to a fresh exec (which resumes the persisted
   * conversation via lastSdkSessionId). ORDER matters, per the intended UX:
   *   (1) FIRST emit session_down → main fails the in-flight turn LOUD (the user
   *       sees "this turn was interrupted"), then
   *   (2) open a fresh exec + update the mapping.
   * A reconnect storm (repeated immediate failures) gives up → disconnected.
   */
  function handleExecDown(sid: string, reason: string): void {
    const entry = execs.get(sid);
    if (!entry) return; // already closed intentionally (close_session)
    const t = now();
    entry.reconnectAt = entry.reconnectAt.filter((ts) => t - ts < RECONNECT_WINDOW_MS);
    if (entry.reconnectAt.length >= MAX_RECONNECTS) {
      execs.delete(sid);
      deps.log('error', `exec ${sid} down-looping (${MAX_RECONNECTS}/${RECONNECT_WINDOW_MS}ms) — giving up`);
      deps.sendToMain(JSON.stringify({ type: 'session_down', sid, reason: `${reason}; reconnect gave up`, willReconnect: false }));
      return;
    }
    // (1) tell main the execution is down FIRST (→ fail-loud turn interruption)…
    deps.sendToMain(JSON.stringify({ type: 'session_down', sid, reason, willReconnect: true }));
    // (2) …then reconnect: fresh exec + updated mapping.
    entry.reconnectAt.push(t);
    entry.missed = 0; entry.unresponsive = false;
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
      execs.set(sid, { proc: startExec(sid, cwd), cwd, reconnectAt: [], missed: 0, unresponsive: false });
      return;
    }

    if (type === 'close_session') {
      if (typeof sid !== 'string') return;
      const entry = execs.get(sid);
      if (entry) {
        execs.delete(sid); // delete BEFORE kill so handleExecDown sees no entry → no reconnect
        entry.proc.kill();
      }
      return;
    }

    if (type === 'ping') {
      // Host-level heartbeat (dispatcher-owned; no sid). Reset the idle watchdog
      // (main is alive) + pong.
      deps.onMainPing?.();
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

  // Inner heartbeat: ping every exec; one that misses INNER_DEAD_MISSES consecutive
  // pings is UNRESPONSIVE (alive but event-loop-blocked — the post-sleep/netdrop
  // wedge the outer heartbeat can't see, since the dispatcher itself still pongs
  // main). "No response" is a down just like "gone": force-kill it → its exit
  // routes through handleExecDown → fail-loud + reconnect. force-kill (not graceful
  // kill) because a wedged exec won't process a stdin EOF.
  let tickSeq = 0;
  function tick(): void {
    tickSeq += 1;
    for (const entry of execs.values()) {
      entry.missed += 1;
      try { entry.proc.writeLine(JSON.stringify({ type: 'ping', seq: tickSeq })); } catch { /* stdin closed */ }
      if (entry.missed >= INNER_DEAD_MISSES && !entry.unresponsive) {
        entry.unresponsive = true;
        entry.proc.forceKill();
      }
    }
  }

  function shutdown(): void {
    for (const entry of execs.values()) entry.proc.kill();
    execs.clear();
  }

  return { onMainLine, tick, shutdown };
}

/** Boot entry: wire the real stdin/stdout + child_process spawn and run. */
export function runDispatcher(): void {
  // Idle-shutdown watchdog (ssh only — main passes --idle-shutdown-min=N; the
  // remote host isn't fate-shared, so a wedged/gone main must not leave the
  // dispatcher + its exec procs burning resources). The exec role no longer arms
  // this (#8) — the dispatcher owns it. See connection-health#2.
  const idleArg = process.argv.find((a) => a.startsWith('--idle-shutdown-min='));
  const IDLE_MS = idleArg ? Math.max(0, Number(idleArg.split('=')[1]) || 0) * 60_000 : 0;
  let watchdog: NodeJS.Timeout | undefined;
  let innerTimer: NodeJS.Timeout | undefined;
  let dispatcher: Dispatcher;
  function resetWatchdog(): void {
    if (!IDLE_MS) return;
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      process.stderr.write(`[dispatcher] idle-shutdown: no ping for ${IDLE_MS / 60_000}min — self-exiting\n`);
      if (innerTimer) clearInterval(innerTimer);
      dispatcher.shutdown();
      process.exit(0);
    }, IDLE_MS);
    watchdog.unref?.();
  }

  dispatcher = createDispatcher({
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
        forceKill: () => child.kill('SIGKILL'),
      };
    },
    sendToMain: (line) => process.stdout.write(line + '\n'),
    log: (level, msg) => process.stderr.write(`[dispatcher] ${level}: ${msg}\n`),
    // Per-host model cache. Coarse TTL (default 30min; env override for tests) —
    // the sole freshness mechanism (no account-guard; see model-cache.ts).
    cache: createModelCache({ ttlMs: Number(process.env.SHELF_MODEL_CACHE_TTL_MS) || 1_800_000 }),
    onMainPing: resetWatchdog,
  });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => dispatcher.onMainLine(line));

  // Inner heartbeat timer (dispatcher→exec hung-detection). Env override for E2E.
  const innerMs = Number(process.env.SHELF_INNER_PING_MS) || 15_000;
  innerTimer = setInterval(() => dispatcher.tick(), innerMs);
  innerTimer.unref?.();
  resetWatchdog(); // arm from boot — if main never pings, it's already gone

  rl.on('close', () => {
    // Main's write-end closed → tear down all exec procs (their stdin EOF cascades
    // to their CLIs) and exit. F adds the normal-closure reap + lease handling.
    clearInterval(innerTimer);
    dispatcher.shutdown();
    process.exit(0);
  });

  // Announce the dispatcher process is up (no sid = dispatcher-level, vs an exec's
  // sid-stamped `ready` which signals a specific session is ready).
  process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
}
