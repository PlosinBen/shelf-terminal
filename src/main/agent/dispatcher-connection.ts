// Main-side owner of ONE per-host dispatcher process (dispatch-layering, group
// D3). Today main spawns a per-tab agent-server and wraps it (see remote.ts
// `wrapProcess`); with the dispatcher, main spawns ONE dispatcher per host and
// multiplexes N tabs over it. This module owns that shared process: the single
// per-host heartbeat + health, and the demux of the dispatcher's stdout BY `sid`
// to a per-session `SessionChannel`. Each SessionChannel implements the same
// `RemoteProcess` shape the per-tab path returns, so `createRemoteBackend` uses
// it as a drop-in (its query/stop/getCapabilities bodies are unchanged).
//
// Guarded by a flag in remote.ts (default off) so today's per-tab path is the
// untouched fallback until the dispatcher path is E2E-proven, then flipped.
import { log } from '@shared/logger';
import type { ConnectionHealth } from '@shared/types';
import type { AgentEvent } from './types';
import { ConnectionHealthTracker, DEFAULT_HEALTH_THRESHOLDS } from './connection-health';
import { createTurnDispatcher, type PermissionHandler } from './turn-dispatcher';

/** The subset of a spawned child process this module drives (injectable for tests). */
export interface DispatcherProc {
  writeLine(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

/** Per-session sinks — same set the per-tab path threads into its turn-dispatcher. */
export interface SessionSinks {
  onTaskEvent?: (ev: any) => void;
  onServerTurn?: (turnId: string, events: AsyncGenerator<AgentEvent>) => void;
  onHealth?: (health: ConnectionHealth) => void;
  onQueue?: (items: any[]) => void;
  onSkillsReloaded?: (ok: boolean, error?: string) => void;
  onSessionEvent?: (event: AgentEvent) => void;
  projectId?: string;
}

/** The `RemoteProcess`-shaped handle a SessionChannel exposes to createRemoteBackend. */
export interface SessionChannel {
  sendLine(msg: object): void;
  registerTurn(turnId: string, permissionHandler: PermissionHandler): AsyncGenerator<AgentEvent>;
  awaitReady(timeoutMs?: number): Promise<boolean>;
  onResponse(requestId: string, expectedType: string, handler: (payload: any) => void): void;
  kill(): void;
}

export interface DispatcherConnectionDeps {
  proc: DispatcherProc;
  /** Same parser the per-tab turn-dispatcher uses (injected to avoid a remote.ts cycle). */
  parseRemoteMessage: (msg: any) => AgentEvent | null;
  /** App-tool bridge handler (injected). */
  handleAppTool: (op: string, args: Record<string, unknown>, ctx: { projectId?: string }) => Promise<any>;
  heartbeatIntervalMs?: number;
  /** Called when the last session closes → owner tears the connection down. */
  onEmpty?: () => void;
  /** Called when the dispatcher proc EXITS (crash / kill) → owner evicts this dead
   *  connection so the next connect spawns a fresh dispatcher. */
  onDown?: () => void;
}

export interface DispatcherConnection {
  /** Register a session and send `open_session`; returns its RemoteProcess-shaped
   *  channel. `env` = this project's injected env map (plain, later + secret) — the
   *  dispatcher is shared per-HOST, so per-PROJECT env can't ride its own process
   *  env; it travels in `open_session` and the dispatcher applies it to the
   *  per-session exec proc it spawns. */
  openSession(sid: string, cwd: string | undefined, sinks: SessionSinks, env?: Record<string, string>): SessionChannel;
  /** Live session count (for ref-counted teardown). */
  size(): number;
  /** Kill the dispatcher proc + all sessions. */
  kill(): void;
}

interface ChannelState {
  sid: string;
  sinks: SessionSinks;
  dispatcher: ReturnType<typeof createTurnDispatcher>;
}

export function createDispatcherConnection(deps: DispatcherConnectionDeps): DispatcherConnection {
  const channels = new Map<string, ChannelState>();
  const intervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEALTH_THRESHOLDS.intervalMs;

  function writeToProc(msg: object): void {
    deps.proc.writeLine(JSON.stringify(msg));
  }

  // ── One per-host heartbeat + health, broadcast to every session's onHealth ──
  const health = new ConnectionHealthTracker(Date.now());
  let lastHealthState = health.evaluate(Date.now()).state;
  let seq = 0;
  const timer = setInterval(() => {
    seq += 1;
    health.onSent(seq, Date.now());
    try {
      writeToProc({ type: 'ping', seq });
    } catch { /* stdin closed — evaluate() will surface dead */ }
    emitHealth();
  }, intervalMs);
  timer.unref?.();

  function emitHealth(): void {
    const h = health.evaluate(Date.now());
    if (h.state !== lastHealthState) {
      lastHealthState = h.state;
      // Dispatcher-level health is host-wide: every session on this host sees it.
      for (const ch of channels.values()) ch.sinks.onHealth?.(h);
    }
  }

  // ── Demux the dispatcher's stdout by sid ──
  deps.proc.onLine((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      log.info('dispatcher-conn', `non-json line, dropping: ${trimmed.slice(0, 100)}`);
      return;
    }
    const type = parsed?.type;

    // Host-level heartbeat ack (no sid).
    if (type === 'pong') {
      if (typeof parsed.seq === 'number') health.onAck(parsed.seq, Date.now());
      emitHealth();
      return;
    }
    // Dispatcher process up (no sid) — distinct from an exec's sid-stamped ready.
    if (type === 'ready' && parsed.sid === undefined) {
      return; // dispatcher readiness is implicit; sessions await their own ready{sid}
    }
    // Diagnostic log from an exec — route centrally (logging needs no sid).
    if (type === 'log') {
      const raw = parsed.level;
      const level: 'error' | 'warn' | 'info' | 'debug' =
        raw === 'error' ? 'error' : raw === 'warn' ? 'warn' : raw === 'debug' ? 'debug' : 'info';
      const tag = typeof parsed.tag === 'string' ? parsed.tag : 'agent-server';
      log[level](tag, typeof parsed.msg === 'string' ? parsed.msg : String(parsed.msg));
      return;
    }

    const sid = parsed?.sid;
    if (typeof sid !== 'string') {
      log.info('dispatcher-conn', `line without sid, dropping type=${type}`);
      return;
    }
    const ch = channels.get(sid);
    if (!ch) {
      log.info('dispatcher-conn', `line for unknown sid ${sid}, dropping type=${type}`);
      return;
    }

    // App-tool bridge — reply must carry sid so the dispatcher routes it back.
    if (type === 'app_tool') {
      const requestId = parsed.requestId;
      const op = typeof parsed.op === 'string' ? parsed.op : '';
      const args = (parsed.args && typeof parsed.args === 'object') ? parsed.args : {};
      void deps.handleAppTool(op, args, { projectId: ch.sinks.projectId }).then((result) => {
        writeToProc({ type: 'app_tool_result', sid, requestId, ...result });
      });
      return;
    }
    // The session's provider execution went down (crashed or unresponsive). The
    // dispatcher will RECONNECT it (open a fresh exec + resume the persisted
    // conversation) — but FIRST, fail-loud: end this sid's in-flight turn(s) with
    // an error so the renderer tells the user the turn was interrupted, the spinner
    // unsticks, and main's sendMessage `finally` clears its pending permissions.
    if (type === 'session_down') {
      const why = typeof parsed.reason === 'string' ? parsed.reason : 'process error';
      log.warn('dispatcher-conn', `session ${sid} down: ${why} (willReconnect=${parsed.willReconnect !== false}) — failing in-flight turns`);
      ch.dispatcher.failAllTurns(`Session process ${why} — this turn was interrupted; the conversation resumes from the last message.`);
      // willReconnect:false = terminal (reconnect attempts exhausted) → dead health
      // for this one tab (session-level, not host-wide). willReconnect:true = a
      // fresh exec is coming; don't flap to dead — the host heartbeat stands and the
      // reconnected exec's ready{sid} resumes the session.
      if (parsed.willReconnect === false) ch.sinks.onHealth?.({ state: 'dead' } as ConnectionHealth);
      return;
    }

    // Everything else is a turn / session event → the sid's turn-dispatcher.
    ch.dispatcher.feed(parsed);
  });

  deps.proc.onExit((code) => {
    log.warn('dispatcher-conn', `dispatcher process exited code=${code} — host down until reconnect`);
    clearInterval(timer);
    for (const ch of channels.values()) ch.sinks.onHealth?.({ state: 'dead' } as ConnectionHealth);
    channels.clear();
    deps.onDown?.(); // owner evicts this dead conn → next connect spawns fresh
  });

  function openSession(sid: string, cwd: string | undefined, sinks: SessionSinks, env?: Record<string, string>): SessionChannel {
    // Re-init of an already-open sid (a tab restarted / reconnected before its old
    // session's teardown fired — sids are per-project persistent, so the same project
    // reuses one). Close the STALE channel first so the dispatcher tears down the old
    // exec, then open fresh. Otherwise the dispatcher drops the duplicate open_session
    // ("already-open") → the restarted tab never readies, and the orphaned old channel's
    // later kill would close the NEW session's exec (Map<sid> collision → "Failed to
    // start agent-server"). The dispatcher processes close→open in order (kill old exec,
    // spawn fresh); the old exec's late exit is ignored via handleExecDown's proc guard.
    if (channels.has(sid)) {
      log.warn('dispatcher-conn', `openSession for already-open sid ${sid} — replacing (close old → open fresh)`);
      channels.delete(sid);
      writeToProc({ type: 'close_session', sid });
    }
    const dispatcher = createTurnDispatcher(
      deps.parseRemoteMessage,
      sinks.onTaskEvent,
      sinks.onServerTurn,
      sinks.onQueue,
      sinks.onSkillsReloaded,
      sinks.onSessionEvent,
    );
    const state: ChannelState = { sid, sinks, dispatcher };
    channels.set(sid, state);
    writeToProc({ type: 'open_session', sid, cwd, env });
    // Seed this session's health immediately. The heartbeat only emits onHealth on
    // a CHANGE from 'healthy', so a fresh/reconnected connection would otherwise
    // never push a 'healthy' — leaving a tab that just RECONNECTED after a dispatcher
    // crash stuck on its stale 'dead' (red) status even though it's fine now. The
    // per-host tracker is optimistic-healthy at connect, so this clears the red.
    sinks.onHealth?.(health.evaluate(Date.now()));

    return {
      sendLine: (msg) => writeToProc({ ...msg, sid }),
      registerTurn: dispatcher.registerTurn,
      awaitReady: dispatcher.awaitReady,
      onResponse: dispatcher.onResponse,
      kill: () => {
        // Identity guard: only close if THIS channel is still the current one for the
        // sid. An orphaned channel (replaced by a re-open) must not close the newer
        // session's exec.
        if (channels.get(sid) !== state) return;
        channels.delete(sid);
        writeToProc({ type: 'close_session', sid });
        if (channels.size === 0) deps.onEmpty?.();
      },
    };
  }

  function kill(): void {
    clearInterval(timer);
    channels.clear();
    deps.proc.kill();
  }

  return { openSession, size: () => channels.size, kill };
}
