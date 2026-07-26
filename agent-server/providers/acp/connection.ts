// ACP connection lifecycle — the transport half of the shared acp/ toolkit.
//
// Semantics-free: opens an ACP CLIENT connection to an agent, either over a
// spawned child process's stdio (production: codex-acp) or in-process against a
// mock AgentApp (tests). Knows nothing about codex specifics.

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  client,
  ndJsonStream,
  methods,
  PROTOCOL_VERSION,
  type AgentApp,
  type ClientContext,
  type Stream,
  type SessionNotification,
  type ClientRequestHandlersByMethod,
} from '@agentclientprotocol/sdk';

/** Handle over a live ACP connection. `agent` drives agent-side methods. */
export interface AcpConnection {
  /** Client context: buildSession(), request(), notify(). */
  readonly agent: ClientContext;
  /** Resolves when the connection closes (stream end / child exit). */
  readonly closed: Promise<void>;
  /** Aborts when the connection closes. */
  readonly signal: AbortSignal;
  /**
   * Resolves when the mandatory ACP `initialize` handshake completes. Any session
   * op (session/new, session/resume) MUST await this first — ACP requires
   * `initialize` as the FIRST request, and spec-strict agents (codex-acp) reject
   * session ops with `{ details: "Not initialized" }` otherwise. Lenient agents
   * (copilot --acp, the test mock) tolerate its absence, which is why the gap only
   * surfaced on codex. See agent-providers.
   */
  readonly initialized: Promise<void>;
  /** Close the connection (and the child process, if any). */
  close(error?: unknown): void;
}

/** Handler for `session/request_permission` (Phase 2 wires this to the wire). */
export type PermissionHandler = ClientRequestHandlersByMethod[typeof methods.client.session.requestPermission];

export interface OpenAcpConnectionOptions {
  name?: string;
  /** Bridges an agent permission request to the client UI. Omit → default deny. */
  onRequestPermission?: PermissionHandler;
  /** Routes every session/update notification (the session driver's sink). */
  onSessionUpdate?: (notification: SessionNotification) => void;
}

/**
 * Open an ACP client connection to `target` (a stdio `Stream` for a spawned
 * agent, or an in-process `AgentApp` for tests). Registers client-side handlers
 * BEFORE connecting.
 */
export function openAcpConnection(
  target: Stream | AgentApp,
  opts: OpenAcpConnectionOptions = {},
): AcpConnection {
  const app = client({ name: opts.name ?? 'shelf' });
  if (opts.onRequestPermission) {
    app.onRequest(methods.client.session.requestPermission, opts.onRequestPermission);
  }
  if (opts.onSessionUpdate) {
    const onUpdate = opts.onSessionUpdate;
    app.onNotification(methods.client.session.update, ({ params }) => { onUpdate(params); });
  }
  // Overload resolves by runtime type (Stream vs AgentApp) — the SDK accepts both.
  const conn = app.connect(target as Stream);
  // ACP mandates `initialize` as the FIRST request, before any session op. Fire it
  // eagerly on open so every connection is handshaken; session ops await
  // `initialized`. We advertise NO fs/terminal client capabilities — Shelf only
  // handles permission requests over ACP (fs/terminal tools run agent-side). Without
  // this, codex-acp rejects session/new with { details: "Not initialized" }.
  const initialized = conn.agent
    .request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    .then(() => undefined);
  return {
    agent: conn.agent,
    closed: conn.closed,
    signal: conn.signal,
    initialized,
    close: (error?: unknown) => conn.close(error),
  };
}

/** A spawned agent child + its ACP stdio stream. */
export interface SpawnedAgent {
  child: ChildProcess;
  stream: Stream;
}

/**
 * Spawn an ACP agent binary and wrap its stdio as an ndjson `Stream`.
 * stdin (we write requests) → agent; stdout (we read updates) ← agent.
 * stderr is left inheritable for diagnostics. The child is a DIRECT child of
 * this process (no detach), so it dies with the agent-server tree.
 */
export function spawnAgentStdio(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): SpawnedAgent {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (!child.stdout || !child.stdin) {
    child.kill();
    throw new Error(`spawnAgentStdio: child "${command}" has no stdio pipes`);
  }
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const readable = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(writable, readable);
  return { child, stream };
}
