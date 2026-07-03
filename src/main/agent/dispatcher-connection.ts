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
}

export interface DispatcherConnection {
  /** Register a session and send `open_session`; returns its RemoteProcess-shaped channel. */
  openSession(sid: string, cwd: string | undefined, sinks: SessionSinks): SessionChannel;
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
  });

  function openSession(sid: string, cwd: string | undefined, sinks: SessionSinks): SessionChannel {
    const dispatcher = createTurnDispatcher(
      deps.parseRemoteMessage,
      sinks.onTaskEvent,
      sinks.onServerTurn,
      sinks.onQueue,
      sinks.onSkillsReloaded,
      sinks.onSessionEvent,
    );
    channels.set(sid, { sid, sinks, dispatcher });
    writeToProc({ type: 'open_session', sid, cwd });

    return {
      sendLine: (msg) => writeToProc({ ...msg, sid }),
      registerTurn: dispatcher.registerTurn,
      awaitReady: dispatcher.awaitReady,
      onResponse: dispatcher.onResponse,
      kill: () => {
        if (channels.delete(sid)) {
          writeToProc({ type: 'close_session', sid });
          if (channels.size === 0) deps.onEmpty?.();
        }
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
